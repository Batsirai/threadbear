import mikecannLint from "mikecann-lint";

export default [
  // Lints the TypeScript in convex/, web/, relay/, runner/ and features/
  // (the GPUI specs' steps, typed by features/tsconfig.json). The rest is
  // Swift, Rust and the public site, each with checks of its own. runner/
  // and features/ aren't React: their use... functions aren't hooks.
  ...(await mikecannLint({
    root: import.meta.dirname,
    ignores: [
      "app/**",
      "desktop/**",
      "android-native/**",
      "ios/**",
      "dock/**",
      "site/**",
      "docs/**",
      "scripts/**",
      "runner/box/spike/**",
    ],
    untyped: ["runner/scripts/**"],
    notReact: ["runner/**", "relay/**", "features/**"],
  })),
  {
    // Disables for rules this setup doesn't turn on, kept for editors that do.
    files: [
      "runner/src/adapters/acp/mcp-http.ts",
      "runner/src/adapters/codex/tools.ts",
      "runner/src/patch-trust.ts",
      "runner/test/unit/context-budget.test.ts",
      "web/src/link-policy.ts",
    ],
    linterOptions: { reportUnusedDisableDirectives: "off" },
  },
];
