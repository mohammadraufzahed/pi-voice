import assert from "node:assert/strict";
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
		if (previousToken === undefined) {
			delete process.env.TG_BOT_TOKEN;
		} else {
			process.env.TG_BOT_TOKEN = previousToken;
		}
	}
});
