import { invoke } from "@tauri-apps/api/core";
import type {
  AnalyticsAccount,
  AnalyticsDashboard,
  AnalyticsFilter,
  AnalyticsImportFormat,
  AnalyticsLogin,
} from "@/types/unifiedUsage";

export const unifiedUsageApi = {
  listAccounts: () => invoke<AnalyticsAccount[]>("unified_usage_list_accounts"),
  importExistingAccounts: () =>
    invoke<{ imported: number; skipped: number; accounts: AnalyticsAccount[] }>(
      "unified_usage_import_existing_accounts",
    ),
  addAccount: (name: string) =>
    invoke<AnalyticsAccount>("unified_usage_add_account", { name }),
  updateAccount: (
    accountId: string,
    name: string,
    syncIntervalMinutes: number,
  ) =>
    invoke<AnalyticsAccount>("unified_usage_update_account", {
      accountId,
      name,
      syncIntervalMinutes,
    }),
  disconnectAccount: (accountId: string) =>
    invoke<void>("unified_usage_disconnect_account", { accountId }),
  removeAccount: (accountId: string) =>
    invoke<void>("unified_usage_remove_account", { accountId }),
  startLogin: (accountId: string) =>
    invoke<AnalyticsLogin>("unified_usage_start_login", { accountId }),
  finishLogin: (accountId: string, loginId: string) =>
    invoke<AnalyticsAccount>("unified_usage_finish_login", {
      accountId,
      loginId,
    }),
  cancelLogin: (accountId: string, loginId: string) =>
    invoke<void>("unified_usage_cancel_login", { accountId, loginId }),
  sync: (accountId?: string) =>
    invoke<{ accounts: AnalyticsAccount[]; errors: string[] }>(
      "unified_usage_sync",
      { accountId },
    ),
  dashboard: (filter: AnalyticsFilter) =>
    invoke<AnalyticsDashboard>("unified_usage_dashboard", { filter }),
  import: (accountId: string, path: string, format: AnalyticsImportFormat) =>
    invoke<{ imported: number; skipped: number; warnings: string[] }>(
      "unified_usage_import",
      { accountId, path, format },
    ),
  export: (path: string) => invoke<void>("unified_usage_export", { path }),
};
