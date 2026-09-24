/**
 * pi-voice — souls speak. TTS → Telegram voice note.
 *
 *   tg_voice(text) — synthesize speech (edge-tts/piper/espeak) and
 *   send as a Telegram voice message via the soul's own bot.
 *
 * TTS backends tried in order:
 *   edge-tts (Microsoft neural, free, pip install edge-tts)
 *   piper    (local neural TTS)
 *   espeak   (robotic fallback, always present)
 *
 * Env: TG_BOT_TOKEN + TG_CHAT (+ TG_THREAD for forum topics).
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { execFile } from "node:child_process";
import { existsSync, unlinkSync } from "node:fs";
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
}
