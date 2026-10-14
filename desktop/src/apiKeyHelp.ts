export const API_KEY_HELP_URLS = {
  console: "https://bailian.console.aliyun.com/cn-beijing/model/settings/api-key",
  guide: "https://help.aliyun.com/zh/model-studio/get-api-key",
} as const;

export type ApiKeyHelpKind = keyof typeof API_KEY_HELP_URLS;
