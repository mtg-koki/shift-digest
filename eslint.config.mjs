import tseslint from "typescript-eslint";

export default tseslint.config(
  {
    ignores: [".next/**", "dist/**", "node_modules/**", "infra/**", "next-env.d.ts", ".offline-feeds/**", "data/**"],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_" }],
    },
  },
);
