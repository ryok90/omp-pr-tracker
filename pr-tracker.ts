/**
 * pr-tracker: lists the pull requests opened or pushed to during the current omp session.
 *
 * Detects PR creation from tool results (`gh pr create` via bash/eval, the `github`
 * tool's `pr_create` op, directly or through `write xd://github`) and pushes (`git push`
 * via bash/eval, resolved to the branch's PR with `gh pr list --head`; the `github` tool's
 * `pr_push` op). Each PR is persisted as a session entry so it survives resume, and shown
 * in a widget below the editor. `/prs` refreshes title/state from GitHub; `/prs toggle`
 * hides/shows it.
 */
import type { ExtensionAPI, ExtensionContext, ToolResultEvent } from "@oh-my-pi/pi-coding-agent";

// Name kept from when only created PRs were tracked: existing (and backfilled) sessions use it.
const ENTRY_TYPE = "pr-tracker.opened";
const WIDGET_KEY = "pr-tracker";
const MAX_ROWS = 10;
const PR_URL = /https:\/\/[^\s/]+\/[\w.-]+\/[\w.-]+\/pull\/\d+/g;
const GH_PR_CREATE = /\bgh\s+pr\s+create\b/;
const GITHUB_PR_CREATE_OP = /["']?op["']?\s*:\s*["']pr_create["']/;
const GIT_PUSH = /\bgit\b[^\n|;&]*\bpush\b/;
const GITHUB_PR_PUSH_OP = /["']?op["']?\s*:\s*["']pr_push["']/;
const PUSH_TARGET = /^To\s+(\S+)/;
// ` * [new branch]  a -> b`, `   1a2b..3c4d  a -> b`, ` + 1a2b...3c4d a -> b (forced update)`
const PUSHED_REF = /^\s*[*+ ]?\s*(?:\[new branch\]|[0-9a-f]+\.\.\.?[0-9a-f]+)\s+\S+\s+->\s+(\S+)/;
const GITHUB_REMOTE = /github\.com[:/]([\w.-]+)\/([\w.-]+?)(?:\.git)?\/?$/;

interface PushedBranch {
	repo: string;
	branch: string;
}

interface TrackedPr {
	url: string;
	openedAt: number;
}

interface PrMetadata {
	title: string;
	state: string;
	isDraft: boolean;
}

// Module scope is shared between the main session and its in-process subagents
// (factories are rebound per session), so subagent detections reach the main widget here.
const mainSessionSinks = new Set<(url: string) => void>();

function isPrCreateCall(toolName: string, input: Record<string, unknown>): boolean {
	switch (toolName) {
		case "bash":
			return GH_PR_CREATE.test(String(input.command ?? ""));
		case "eval": {
			const code = String(input.code ?? "");
			return GH_PR_CREATE.test(code) || GITHUB_PR_CREATE_OP.test(code);
		}
		case "github":
			return input.op === "pr_create";
		case "write":
			return String(input.path ?? "").startsWith("xd://github") && GITHUB_PR_CREATE_OP.test(String(input.content ?? ""));
		default:
			return false;
	}
}

function resultText(event: ToolResultEvent): string {
	return event.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

function createdPrUrls(event: ToolResultEvent): string[] {
	// No `isError` gate: a compound command (`gh pr create … ; pkill …`) can exit non-zero after the
	// PR was opened. A URL in a create call's output is a real PR, even gh's "already exists" one.
	if (!isPrCreateCall(event.toolName, event.input)) return [];
	// One call can open several PRs (e.g. `gh pr create` per branch in a loop), so keep every URL.
	return [...new Set(resultText(event).match(PR_URL))];
}

function isPushCall(toolName: string, input: Record<string, unknown>): boolean {
	switch (toolName) {
		case "bash":
			return GIT_PUSH.test(String(input.command ?? ""));
		case "eval":
			return GIT_PUSH.test(String(input.code ?? ""));
		default:
			return false;
	}
}

function isPrPushCall(toolName: string, input: Record<string, unknown>): boolean {
	if (toolName === "github") return input.op === "pr_push";
	if (toolName === "write") {
		return String(input.path ?? "").startsWith("xd://github") && GITHUB_PR_PUSH_OP.test(String(input.content ?? ""));
	}
	return toolName === "eval" && GITHUB_PR_PUSH_OP.test(String(input.code ?? ""));
}

/** Branches updated on GitHub remotes, read from git's own push report (`To <remote>` + ref lines). */
function pushedBranches(text: string): PushedBranch[] {
	const found = new Map<string, PushedBranch>();
	let repo: string | undefined;
	for (const line of text.split("\n")) {
		const target = PUSH_TARGET.exec(line);
		if (target) {
			const remote = GITHUB_REMOTE.exec(target[1]);
			repo = remote ? `${remote[1]}/${remote[2]}` : undefined;
			continue;
		}
		const ref = repo ? PUSHED_REF.exec(line) : null;
		if (!repo || !ref) continue;
		const branch = ref[1].replace(/^refs\/heads\//, "");
		found.set(`${repo}:${branch}`, { repo, branch });
	}
	return [...found.values()];
}

function loadTrackedPrs(ctx: ExtensionContext): TrackedPr[] {
	// All entries, not just the active branch: a PR stays open on GitHub after a rewind.
	const byUrl = new Map<string, TrackedPr>();
	for (const entry of ctx.sessionManager.getEntries()) {
		if (entry.type !== "custom" || entry.customType !== ENTRY_TYPE) continue;
		const pr = entry.data as TrackedPr | undefined;
		if (pr?.url && !byUrl.has(pr.url)) byUrl.set(pr.url, pr);
	}
	return [...byUrl.values()];
}

interface ComposerBorderColorInput {
	sessionName?: string;
	thinkingLevel?: string;
}

// omp's own composer border rule: a theme key from the thinking level, or a hex derived from the
// session name. Internal module, so it's loaded lazily and the widget falls back to "border" if
// a later omp moves it, instead of the whole extension failing to load.
let composerBorderColor: ((input: ComposerBorderColorInput) => string) | undefined;
void import("@oh-my-pi/pi-coding-agent/modes/interactive/border-color")
	.then((mod: object) => {
		if ("composerBorderColor" in mod && typeof mod.composerBorderColor === "function") {
			composerBorderColor = mod.composerBorderColor as (input: ComposerBorderColorInput) => string;
		}
	})
	.catch(() => undefined);

function paintHex(hex: string, text: string): string {
	const value = Number.parseInt(hex.slice(1), 16);
	return `\x1b[38;2;${(value >> 16) & 255};${(value >> 8) & 255};${value & 255}m${text}\x1b[39m`;
}

export default function prTracker(pi: ExtensionAPI): void {
	let prs: TrackedPr[] = [];
	const metadata = new Map<string, PrMetadata>();
	let visible = true;
	let mainCtx: ExtensionContext | undefined;

	function stateLabel(ctx: ExtensionContext, meta: PrMetadata | undefined): string {
		const theme = ctx.ui.theme;
		if (!meta) return theme.fg("dim", "…     ");
		if (meta.isDraft && meta.state === "OPEN") return theme.fg("warning", "DRAFT ");
		switch (meta.state) {
			case "OPEN":
				return theme.fg("success", "OPEN  ");
			case "MERGED":
				return theme.fg("accent", "MERGED");
			default:
				return theme.fg("muted", meta.state.padEnd(6));
		}
	}

	function render(): void {
		const ctx = mainCtx;
		if (!ctx?.hasUI) return;
		if (!visible || prs.length === 0) {
			ctx.ui.setWidget(WIDGET_KEY, undefined);
			return;
		}
		const theme = ctx.ui.theme;
		const shown = prs.slice(0, MAX_ROWS);
		const lines = [
			theme.fg("muted", `PRs of this session (${prs.length})`),
			...shown.map(pr => {
				const meta = metadata.get(pr.url);
				const title = meta ? `  ${theme.fg("dim", meta.title)}` : "";
				return `${stateLabel(ctx, meta)} ${pr.url}${title}`;
			}),
		];
		if (prs.length > shown.length) lines.push(theme.fg("dim", `… ${prs.length - shown.length} more (/prs)`));
		// Docked above the prompt; the leading rule separates the list from the transcript above it.
		// omp takes a string array or a factory; the factory returns a `{ render(width) }` rows object
		// so the rule can span the full width. A bare rows object (no factory) crashes the TUI.
		const rule = theme.symbols.box.horizontal;
		// Colour is resolved per frame so it follows the prompt's when the session is renamed or the
		// thinking level changes. Bash/python/vim input modes recolour the prompt but aren't visible here.
		const paintRule = (text: string): string => {
			const color = composerBorderColor?.({ sessionName: pi.getSessionName(), thinkingLevel: pi.getThinkingLevel() });
			if (color?.startsWith("#")) return paintHex(color, text);
			try {
				return theme.fg((color ?? "border") as Parameters<typeof theme.fg>[0], text);
			} catch {
				return theme.fg("border", text);
			}
		};
		ctx.ui.setWidget(
			WIDGET_KEY,
			// Rows indented one column, like the prompt's own padding; the rule stays full width.
			() => ({ render: (width: number): string[] => [paintRule(rule.repeat(width)), ...lines.map(line => ` ${line}`)] }),
			{ placement: "aboveEditor" },
		);
	}

	async function fetchMetadata(url: string): Promise<void> {
		try {
			const result = await pi.exec("gh", ["pr", "view", url, "--json", "title,state,isDraft"], { timeout: 15_000 });
			if (result.code !== 0) {
				pi.logger.warn("pr-tracker: gh pr view failed", { url, stderr: result.stderr });
				return;
			}
			metadata.set(url, JSON.parse(result.stdout) as PrMetadata);
		} catch (error) {
			pi.logger.warn("pr-tracker: metadata fetch failed", { url, error: String(error) });
		}
	}

	async function refreshAll(): Promise<void> {
		await Promise.all(prs.map(pr => fetchMetadata(pr.url)));
		render();
	}

	function record(url: string): void {
		if (prs.some(pr => pr.url === url)) return;
		const pr: TrackedPr = { url, openedAt: Date.now() };
		prs.push(pr);
		pi.appendEntry(ENTRY_TYPE, pr);
		render();
		void fetchMetadata(url).then(render);
	}

	function restore(ctx: ExtensionContext): void {
		if (ctx.agent.kind !== "main") return;
		// Re-registered on every restore: switch/branch/tree can follow a shutdown without a new start.
		mainSessionSinks.add(record);
		mainCtx = ctx;
		prs = loadTrackedPrs(ctx);
		render();
		void refreshAll();
	}

	pi.on("session_start", (_event, ctx) => restore(ctx));
	pi.on("session_switch", (_event, ctx) => restore(ctx));
	pi.on("session_branch", (_event, ctx) => restore(ctx));
	pi.on("session_tree", (_event, ctx) => restore(ctx));
	pi.on("session_shutdown", () => {
		mainSessionSinks.delete(record);
	});

	async function prForBranch({ repo, branch }: PushedBranch): Promise<string | undefined> {
		try {
			const result = await pi.exec(
				"gh",
				["pr", "list", "--repo", repo, "--head", branch, "--state", "all", "--json", "url", "--limit", "1"],
				{ timeout: 15_000 },
			);
			if (result.code !== 0) {
				pi.logger.warn("pr-tracker: gh pr list failed", { repo, branch, stderr: result.stderr });
				return undefined;
			}
			return (JSON.parse(result.stdout) as { url: string }[])[0]?.url;
		} catch (error) {
			pi.logger.warn("pr-tracker: PR lookup failed", { repo, branch, error: String(error) });
			return undefined;
		}
	}

	function deliver(url: string, ctx: ExtensionContext): void {
		if (ctx.agent.kind === "main") record(url);
		else for (const sink of mainSessionSinks) sink(url);
	}

	pi.on("tool_result", (event, ctx) => {
		for (const url of createdPrUrls(event)) deliver(url, ctx);
		if (event.isError) return;
		if (isPrPushCall(event.toolName, event.input)) {
			for (const url of new Set(resultText(event).match(PR_URL))) deliver(url, ctx);
		}
		if (!isPushCall(event.toolName, event.input)) return;
		// Lookup runs detached so the tool result isn't held up by `gh`; a push before the PR
		// exists finds nothing, and the later `gh pr create` records it instead.
		for (const pushed of pushedBranches(resultText(event))) {
			void prForBranch(pushed).then(url => {
				if (url) deliver(url, ctx);
			});
		}
	});

	const SUBCOMMANDS = [
		{ value: "add", label: "add", description: "Track PR URLs this session missed: /prs add <url> [url…]" },
		{ value: "toggle", label: "toggle", description: "Hide or show the PR list" },
	];

	pi.registerCommand("prs", {
		description: "Refresh the PRs of this session; `/prs add <url>` tracks a PR; `/prs toggle` hides or shows the list",
		getArgumentCompletions: prefix => {
			const matches = SUBCOMMANDS.filter(sub => sub.value.startsWith(prefix));
			return matches.length > 0 ? matches : null;
		},
		handler: async (args, ctx) => {
			const [sub = "", ...rest] = args.trim().split(/\s+/);
			if (sub === "toggle") {
				visible = !visible;
				render();
				return;
			}
			if (sub === "add") {
				const urls = [...new Set(rest.join(" ").match(PR_URL))];
				if (urls.length === 0) {
					ctx.ui.notify("Usage: /prs add https://github.com/<owner>/<repo>/pull/<n> [more URLs]", "warning");
					return;
				}
				const added = urls.filter(url => !prs.some(pr => pr.url === url));
				visible = true;
				for (const url of added) record(url);
				const skipped = urls.length - added.length;
				ctx.ui.notify(
					`Added ${added.length} PR${added.length === 1 ? "" : "s"}${skipped > 0 ? `, ${skipped} already tracked` : ""}`,
					"info",
				);
				return;
			}
			if (prs.length === 0) {
				ctx.ui.notify("No PRs in this session yet", "info");
				return;
			}
			visible = true;
			await refreshAll();
			ctx.ui.notify(`Refreshed ${prs.length} PR${prs.length === 1 ? "" : "s"}`, "info");
		},
	});
}
