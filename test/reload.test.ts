import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
	createAgentSession,
	DefaultResourceLoader,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));

function assertAskUserExposed(session: {
	getAllTools(): Array<{ name: string }>;
	getActiveToolNames(): string[];
}): void {
	assert.equal(
		session.getAllTools().some((tool) => tool.name === "ask_user"),
		true,
		"ask_user should remain registered",
	);
	assert.equal(
		session.getActiveToolNames().includes("ask_user"),
		true,
		"ask_user should remain active",
	);
}

test("ask_user remains registered and active after reload", async () => {
	const agentDir = fs.mkdtempSync(
		path.join(os.tmpdir(), "pi-ask-user-reload-"),
	);
	fs.writeFileSync(
		path.join(agentDir, "settings.json"),
		JSON.stringify({ packages: [packageRoot] }),
	);
	const settingsManager = SettingsManager.create(packageRoot, agentDir);
	const resourceLoader = new DefaultResourceLoader({
		cwd: packageRoot,
		agentDir,
		settingsManager,
		noSkills: true,
		noPromptTemplates: true,
		noThemes: true,
		noContextFiles: true,
	});

	try {
		await resourceLoader.reload();
		assert.deepEqual(resourceLoader.getExtensions().errors, []);
		const { session } = await createAgentSession({
			cwd: packageRoot,
			resourceLoader,
			settingsManager,
			sessionManager: SessionManager.inMemory(),
		});
		try {
			assertAskUserExposed(session);
			await session.reload();
			assert.deepEqual(resourceLoader.getExtensions().errors, []);
			assertAskUserExposed(session);
		} finally {
			session.dispose();
		}
	} finally {
		fs.rmSync(agentDir, { recursive: true, force: true });
	}
});
