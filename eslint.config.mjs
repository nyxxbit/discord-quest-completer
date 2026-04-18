// Minimal flat config for Orion (single-file IIFE, no build system).
// Run locally with: npx eslint@9 index.js
export default [
    {
        // The Vencord userplugin is TypeScript and is built by Vencord's
        // own toolchain — not by this config. Ignore it here.
        ignores: ["vencord-plugin/**"],
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
