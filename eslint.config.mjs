import typescriptConfig from '@playcanvas/eslint-config/typescript';
import globals from 'globals';

export default [
    // the inspector is vendored as published upstream; fixes go there
    { ignores: ['plugins/playcanvas-stage/web/live/inspector/**'] },
    ...typescriptConfig,
    {
        rules: {
            // `a && b()` and empty no-op callbacks are deliberate idioms here, as in the editor
            '@typescript-eslint/no-unused-expressions': ['error', { allowShortCircuit: true, allowTernary: true }],
            '@typescript-eslint/no-empty-function': ['error', { allow: ['arrowFunctions'] }],
            'no-empty': ['error', { allowEmptyCatch: true }]
        }
    },
    {
        // tests read arbitrary http and json-rpc bodies, and their assertions do the checking
        files: ['test/**'],
        rules: {
            '@typescript-eslint/no-explicit-any': 'off'
        }
    },
    {
        // the viewer shell, the frame runtime, the live scene tools and the test apps run in the browser
        files: ['plugins/playcanvas-stage/web/**', 'test/fixtures/**'],
        languageOptions: {
            globals: globals.browser
        },
        rules: {
            // the live tools' playcanvas import is rewritten to the app's own engine
            'import-x/no-unresolved': ['error', { ignore: ['^playcanvas(/|$)'] }]
        }
    }
];
