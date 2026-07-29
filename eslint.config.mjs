// Minimal flat config for Orion (single-file IIFE, no build system).
// Run locally with: npx eslint@9 index.js
export default [
    {
        // The Vencord userplugin sources (index.tsx, native.ts, orion.ts, ...)
        // live at the repo root so UserpluginInstaller can clone this repo
        // straight into src/userplugins. They are TypeScript and are built by
        // Vencord's own toolchain — not by this config. Ignore them here.
        ignores: ["**/*.ts", "**/*.tsx"],
    },
    {
        // ESM config files (this very file)
        files: ["**/*.mjs"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "module",
        },
    },
    {
        files: ["index.js"],
        languageOptions: {
            ecmaVersion: "latest",
            sourceType: "script",
            globals: {
                // Browser globals used by Orion
                window: "readonly",
                document: "readonly",
                navigator: "readonly",
                location: "readonly",
                console: "readonly",
                fetch: "readonly",
                Notification: "readonly",
                setTimeout: "readonly",
                clearTimeout: "readonly",
                setInterval: "readonly",
                clearInterval: "readonly",
                requestAnimationFrame: "readonly",
                cancelAnimationFrame: "readonly",
                MutationObserver: "readonly",
                URL: "readonly",
                URLSearchParams: "readonly",
                FormData: "readonly",
                // Discord-injected
                webpackChunkdiscord_app: "readonly",
            },
        },
        rules: {
            "no-undef": "error",
            "no-unused-vars": [
                "warn",
                {
                    argsIgnorePattern: "^_",
                    caughtErrorsIgnorePattern: "^_|^e$|^err$|^error$|^ex$",
                    varsIgnorePattern: "^_",
                },
            ],
            "no-empty": ["error", { allowEmptyCatch: true }],
            "no-constant-condition": ["error", { checkLoops: false }],
            "no-unsafe-optional-chaining": "error",
        },
    },
];
