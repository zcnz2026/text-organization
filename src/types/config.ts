export type GeminiModelId = string;

export type KeyRotationStrategy = "round_robin" | "failover";

export interface OAuthClientCredentials {
  clientId: string;
  clientSecret: string;
  tokenUri: string;
  authUri: string;
}

export interface OAuthSessionInfo {
  hasClientJson: boolean;
  authorized: boolean;
  email: string;
  clientIdMasked: string;
  expiresAt: number;
}

export interface GeminiPoolConfig {
  enabled: boolean;
  model: GeminiModelId;
  reviewModel?: string;
  paidUnlimited?: boolean;
  rotation: KeyRotationStrategy;
  keyCount: number;
  maskedKeys: string[];
}

export interface WorkbenchSettings {
  sourceSpreadsheetUrl: string;
  sourceSheetName: string;
  resourceMatrixUrl: string;
  rosterSpreadsheetUrl: string;
  outputSpreadsheetUrl: string;
  selectedLanguages: string[];
  enableRosterPreFill: boolean;
  overwriteExistingSheets: boolean;
  themeMode: "system" | "light" | "dark";
}
