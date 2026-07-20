export type JsonObject = { [key: string]: JsonValue };
export type JsonValue = string | number | boolean | null | JsonObject | JsonValue[];

export interface Account extends JsonObject {
  name: string;
  platform: string;
  type: string;
  credentials: JsonObject;
}

export interface UsageWindow {
  key: string;
  label: string;
  utilization: number;
  remainingPercent: number;
}

export interface TelegramChat {
  id: number;
  type: string;
}

export interface TelegramDocument {
  file_id: string;
  file_name?: string;
  mime_type?: string;
}

export interface TelegramMessage {
  message_id: number;
  chat: TelegramChat;
  from?: { id: number };
  text?: string;
  document?: TelegramDocument;
}

export interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}
