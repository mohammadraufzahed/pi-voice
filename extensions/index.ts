/**
 * pi-voice — souls speak, souls hear.
 *
 *   tg_voice(text)          — synthesize speech (edge-tts/piper/espeak)
 *                             and send as a Telegram voice message.
 *   tg_transcribe(file_id)  — download a Telegram voice/audio file and
 *                             transcribe it to text (STT).
 *
 * TTS backends tried in order:
 *   edge-tts (Microsoft neural, free, pip install edge-tts)
 *   piper    (local neural TTS)
 *   espeak   (robotic fallback, always present)
 *
 * STT backends tried in order (first available wins):
 *   Groq API      (GROQ_API_KEY, OpenAI-compatible, whisper-large-v3-turbo,
 *                  Persian, free tier, zero local deps)
 *   OpenAI API    (OPENAI_API_KEY, whisper-1)
 *   Vosk          (vosk-transcriber CLI + a small model, ~42MB fa model,
 *                  set VOSK_MODEL — offline, no PyTorch)
 *   whisper.cpp   (whisper-cli, local fallback — ggml-tiny.bin ~75MB,
 *                  set WHISPER_MODEL or it looks in common paths)
 *
 * Env: TG_BOT_TOKEN + TG_CHAT (+ TG_THREAD for forum topics).
 *      GROQ_API_KEY   — Groq API key (highest-priority STT backend).
 *      OPENAI_API_KEY — OpenAI Whisper API key.
 *      VOSK_MODEL     — path to a Vosk model dir (e.g. vosk-model-small-fa-0.5).
 *      WHISPER_MODEL  — path to a whisper.cpp ggml model.
 *      STT_LANG       — transcription language (default "fa").
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, unlinkSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Type } from "typebox";

function sh(cmd: string, args: string[], timeout = 30_000): Promise<number> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout }, (e) =>
			resolve(e ? (typeof (e as any).code === "number" ? (e as any).code : 1) : 0),
		);
	});
}

function shOut(cmd: string, args: string[], timeout = 120_000): Promise<string | null> {
	return new Promise((resolve) => {
		execFile(cmd, args, { timeout, maxBuffer: 16 * 1024 * 1024 }, (e, stdout) =>
			resolve(e ? null : stdout),
		);
	});
}

async function downloadTgFile(fileId: string): Promise<string | null> {
	const token = process.env.TG_BOT_TOKEN;
	if (!token) return null;
	const meta = await (
		await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${encodeURIComponent(fileId)}`)
	).json();
	if (!meta.ok || !meta.result?.file_path) return null;
	const ext = meta.result.file_path.split(".").pop() ?? "oga";
	const dest = join(tmpdir(), `stt-${randomUUID()}.${ext}`);
	const res = await fetch(`https://api.telegram.org/file/bot${token}/${meta.result.file_path}`);
	if (!res.ok) return null;
	await (await import("node:fs/promises")).writeFile(dest, new Uint8Array(await res.arrayBuffer()));
	return dest;
}

/** Convert any audio to 16kHz mono wav (whisper.cpp input). */
async function toWav(src: string): Promise<string | null> {
	const dest = `${src}.wav`;
	const code = await sh("ffmpeg", ["-y", "-i", src, "-ar", "16000", "-ac", "1", "-c:a", "pcm_s16le", dest], 60_000);
	return code === 0 && existsSync(dest) ? dest : null;
}

function whisperModel(): string | null {
	if (process.env.WHISPER_MODEL && existsSync(process.env.WHISPER_MODEL))
		return process.env.WHISPER_MODEL;
	const home = process.env.HOME ?? "/root";
	for (const p of [
		`${home}/.local/share/whisper.cpp/ggml-tiny.bin`,
		`${home}/.local/share/whisper.cpp/ggml-base.bin`,
		`${home}/.local/share/whisper.cpp/ggml-small.bin`,
		"/usr/local/share/whisper.cpp/ggml-tiny.bin",
		"/usr/local/share/whisper.cpp/ggml-base.bin",
	])
		if (existsSync(p)) return p;
	return null;
}

/** POST audio to an OpenAI-compatible /audio/transcriptions endpoint. */
async function whisperApi(file: string, url: string, key: string, model: string, lang: string): Promise<string | null> {
	const fd = new FormData();
	const data = new Uint8Array(await (await import("node:fs/promises")).readFile(file));
	fd.append("file", new Blob([data]), file.split("/").pop() ?? "audio.oga");
	fd.append("model", model);
	fd.append("language", lang);
	try {
		const r = await fetch(url, {
			method: "POST",
			headers: { Authorization: `Bearer ${key}` },
			body: fd,
		});
		if (!r.ok) return null;
		const j = await r.json();
		return j.text?.trim() || null;
	} catch {
		return null;
	}
}

function voskModel(): string | null {
	if (process.env.VOSK_MODEL && existsSync(process.env.VOSK_MODEL))
		return process.env.VOSK_MODEL;
	const home = process.env.HOME ?? "/root";
	for (const p of [
		`${home}/.local/share/vosk/vosk-model-small-fa-0.5`,
		"/usr/local/share/vosk/vosk-model-small-fa-0.5",
	])
		if (existsSync(p)) return p;
	return null;
}

async function transcribe(file: string): Promise<string | null> {
	const lang = process.env.STT_LANG ?? "fa";
	// 1. Groq API — OpenAI-compatible, free tier, no local deps. Sends the
	//    original file straight through — no ffmpeg conversion needed.
	if (process.env.GROQ_API_KEY) {
		const out = await whisperApi(
			file,
			"https://api.groq.com/openai/v1/audio/transcriptions",
			process.env.GROQ_API_KEY,
			process.env.GROQ_STT_MODEL ?? "whisper-large-v3-turbo",
			lang,
		);
		if (out) return out;
	}
	// 2. OpenAI Whisper API
	if (process.env.OPENAI_API_KEY) {
		const out = await whisperApi(
			file,
			"https://api.openai.com/v1/audio/transcriptions",
			process.env.OPENAI_API_KEY,
			"whisper-1",
			lang,
		);
		if (out) return out;
	}
	// 3. Vosk — offline, ~42MB fa model, no PyTorch (pip install vosk-transcriber)
	const vosk = voskModel();
	if (vosk) {
		const txt = `${file}.vosk.txt`;
		const code = await sh("vosk-transcriber", ["-m", vosk, "-i", file, "-o", txt, "-t", "txt"]);
		if (code === 0 && existsSync(txt)) {
			const t = readFileSync(txt, "utf8").trim();
			try { unlinkSync(txt); } catch { /* ok */ }
			if (t) return t;
		}
	}
	// 4. whisper.cpp — local fallback, ggml-tiny is enough
	const model = whisperModel();
	if (model) {
		const wav = await toWav(file);
		if (wav) {
			try {
				for (const bin of ["whisper-cli", "whisper-cpp", "main"]) {
					const out = await shOut(bin, ["-m", model, "-l", lang, "-nt", "-f", wav]);
					if (out?.trim()) return out.trim();
				}
			} finally {
				try { unlinkSync(wav); } catch { /* ok */ }
			}
		}
	}
	return null;
}

async function synth(text: string): Promise<string | null> {
	const base = join(tmpdir(), `voice-${randomUUID()}`);
	// edge-tts — best quality (Persian voices exist: fa-IR-DilarNeural)
	if ((await sh("edge-tts", ["--voice", "fa-IR-DilarNeural", "--text", text, "--write-media", `${base}.mp3`])) === 0)
		return `${base}.mp3`;
	if ((await sh("edge-tts", ["--text", text, "--write-media", `${base}.mp3`])) === 0)
		return `${base}.mp3`;
	// piper — local neural
	if ((await sh("bash", ["-c", `echo ${JSON.stringify(text)} | piper --output_file ${base}.wav`])) === 0)
		return `${base}.wav`;
	// espeak — robotic but universal
	if ((await sh("espeak-ng", ["-v", "fa", "-w", `${base}.wav`, text])) === 0)
		return `${base}.wav`;
	if ((await sh("espeak", ["-w", `${base}.wav`, text])) === 0)
		return `${base}.wav`;
	return null;
}

export default function piVoice(pi: ExtensionAPI) {
	pi.registerTool({
		name: "tg_voice",
		label: "Telegram Voice",
		description:
			"Send a voice note — text → speech → Telegram voice message as your bot. Persian text → fa-IR voice when available.",
		promptSnippet: "Send a voice note",
		parameters: Type.Object({
			text: Type.String({ description: "what to say" }),
			reply_to: Type.Optional(Type.Number()),
		}),
		async execute(_id, p) {
			const file = await synth(p.text);
			if (!file)
				return {
					content: [{
						type: "text" as const,
						text: "(no TTS backend — install edge-tts: pip install edge-tts)",
					}],
				};
			try {
				const token = process.env.TG_BOT_TOKEN;
				const chat = process.env.TG_CHAT;
				const fd = new FormData();
				fd.append("chat_id", String(chat));
				if (process.env.TG_THREAD)
					fd.append("message_thread_id", process.env.TG_THREAD);
				if (p.reply_to) fd.append("reply_to_message_id", String(p.reply_to));
				const blob = new Blob([new Uint8Array(await (await import("node:fs/promises")).readFile(file))]);
				fd.append("voice", blob, "voice.ogg");
				const r = await fetch(
					`https://api.telegram.org/bot${token}/sendVoice`,
					{ method: "POST", body: fd },
				);
				const j = await r.json();
				return {
					content: [{
						type: "text" as const,
						text: j.ok ? "voice sent 🎙" : `failed: ${JSON.stringify(j)}`,
					}],
				};
			} finally {
				try { unlinkSync(file); } catch { /* ok */ }
			}
		},
	});

	pi.registerTool({
		name: "tg_transcribe",
		label: "Telegram Transcribe",
		description:
			"Transcribe a Telegram voice/audio message to text — pass its file_id. " +
			"Backends tried in order: Groq API → OpenAI API → Vosk → whisper.cpp. " +
			"Language defaults to Persian (STT_LANG env to override).",
		promptSnippet: "Transcribe a voice message",
		parameters: Type.Object({
			file_id: Type.String({ description: "Telegram file_id of the voice/audio message" }),
		}),
		async execute(_id, p) {
			const file = await downloadTgFile(p.file_id);
			if (!file)
				return {
					content: [{
						type: "text" as const,
						text: "(could not download file — check file_id and TG_BOT_TOKEN)",
					}],
				};
			try {
				const text = await transcribe(file);
				return {
					content: [{
						type: "text" as const,
						text: text
							? text
							: "(no STT backend — set GROQ_API_KEY/OPENAI_API_KEY, or install Vosk / whisper.cpp + a model)",
					}],
				};
			} finally {
				try { unlinkSync(file); } catch { /* ok */ }
			}
		},
	});
}
