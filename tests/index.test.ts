import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import test from "node:test";
import piVoice from "../extensions/index.ts";

type RegisteredTool = {
	name: string;
	label: string;
	description: string;
	promptSnippet: string;
	parameters: unknown;
	execute: (id: string, params: Record<string, unknown>) => Promise<{
		content: Array<{ type: "text"; text: string }>;
		details: Record<string, unknown>;
	}>;
};

function registerTools(): RegisteredTool[] {
	const tools: RegisteredTool[] = [];

	piVoice({
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
	} as never);

	return tools;
}

test("registers tg_voice and tg_transcribe tools", () => {
	const tools = registerTools();

	assert.deepEqual(tools.map((tool) => tool.name), ["tg_voice", "tg_transcribe"]);
	assert.equal(tools[0]?.label, "Telegram Voice");
	assert.equal(tools[1]?.label, "Telegram Transcribe");
});

test("tg_voice requires text and supports reply_to", () => {
	const [voice] = registerTools();
	const schema = voice?.parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};

	assert.ok(schema.properties?.text);
	assert.ok(schema.properties?.reply_to);
	assert.deepEqual(schema.required, ["text"]);
});

test("tg_transcribe requires a Telegram file_id", () => {
	const transcribe = registerTools().find((tool) => tool.name === "tg_transcribe");
	const schema = transcribe?.parameters as {
		properties?: Record<string, unknown>;
		required?: string[];
	};

	assert.ok(schema.properties?.file_id);
	assert.deepEqual(schema.required, ["file_id"]);
});

test("tg_transcribe reports download failures without an STT backend", async () => {
	const previousToken = process.env.TG_BOT_TOKEN;
	delete process.env.TG_BOT_TOKEN;
	try {
		const transcribe = registerTools().find((tool) => tool.name === "tg_transcribe");
		assert.ok(transcribe);

		const result = await transcribe.execute("test", { file_id: "bad-file-id" });

		assert.equal(result.content[0]?.type, "text");
		assert.match(result.content[0]?.text ?? "", /could not download file/);
	} finally {
		restoreEnv("TG_BOT_TOKEN", previousToken);
	}
});

test("tg_transcribe handles STT API network failures and removes downloaded temp files", async () => {
	const previousToken = process.env.TG_BOT_TOKEN;
	const previousGroqKey = process.env.GROQ_API_KEY;
	const previousOpenAiKey = process.env.OPENAI_API_KEY;
	const previousVoskModel = process.env.VOSK_MODEL;
	const previousWhisperModel = process.env.WHISPER_MODEL;
	const previousFetch = globalThis.fetch;
	const beforeFiles = await sttTempFiles();

	process.env.TG_BOT_TOKEN = "test-token";
	process.env.GROQ_API_KEY = "test-groq-key";
	delete process.env.OPENAI_API_KEY;
	delete process.env.VOSK_MODEL;
	delete process.env.WHISPER_MODEL;

	globalThis.fetch = async (input: string | URL | Request) => {
		const url = String(input);
		if (url.includes("/getFile?")) {
			return jsonResponse({ ok: true, result: { file_path: "voice/test.oga" } });
		}
		if (url.includes("/file/")) {
			return new Response(new Uint8Array([1, 2, 3]), { status: 200 });
		}
		if (url.includes("/audio/transcriptions")) {
			throw new Error("network down");
		}
		throw new Error(`unexpected fetch: ${url}`);
	};

	try {
		const transcribe = registerTools().find((tool) => tool.name === "tg_transcribe");
		assert.ok(transcribe);

		const result = await transcribe.execute("test", { file_id: "voice-file-id" });

		assert.match(result.content[0]?.text ?? "", /no STT backend/);
		assert.deepEqual(await sttTempFiles(), beforeFiles);
	} finally {
		globalThis.fetch = previousFetch;
		restoreEnv("TG_BOT_TOKEN", previousToken);
		restoreEnv("GROQ_API_KEY", previousGroqKey);
		restoreEnv("OPENAI_API_KEY", previousOpenAiKey);
		restoreEnv("VOSK_MODEL", previousVoskModel);
		restoreEnv("WHISPER_MODEL", previousWhisperModel);
	}
});

async function sttTempFiles(): Promise<string[]> {
	return (await readdir(tmpdir()))
		.filter((file) => file.startsWith("stt-") && file.endsWith(".oga"))
		.sort();
}

function jsonResponse(body: unknown): Response {
	return new Response(JSON.stringify(body), {
		status: 200,
		headers: { "content-type": "application/json" },
	});
}

function restoreEnv(name: string, value: string | undefined): void {
	if (value === undefined) {
		delete process.env[name];
		return;
	}

	process.env[name] = value;
}
