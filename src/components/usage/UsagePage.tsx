import { useState } from "react";
import { useTranslation } from "react-i18next";
import { PageTabs } from "@/components/ui/page-tabs";
import { UnifiedUsageDashboard } from "./UnifiedUsageDashboard";
import { useSettings } from "@/hooks/useSettings";
import { useAutoExchangeRates } from "@/hooks/useAutoExchangeRates";
import type { SettingsFormState } from "@/hooks/useSettings";
import type { AppTypeFilter } from "@/types/usage";
import { UsageDashboard } from "./UsageDashboard";

interface UsagePageProps {
  /** 从应用页「查看此应用的用量」进入时带上的应用筛选 */
  initialAppType?: AppTypeFilter;
  /** 打开设置 → 本地路由（「记录请求用量」开关在那里） */
  onOpenRoutingSettings?: () => void;
}

/** 侧栏「用量统计」全局页（v7 S6）：不开路由也有数据（读会话日志）。 */
export function UsagePage({
  initialAppType,
  onOpenRoutingSettings,
}: UsagePageProps = {}) {
  const { settings, autoSaveSettings } = useSettings();
  const { t } = useTranslation();
  const [view, setView] = useState<"device" | "accounts">("device");

  const save = async (updates: Partial<SettingsFormState>) => {
    try {
      return (await autoSaveSettings(updates)) != null;
    } catch {
      // useSettings 已提示保存失败；将结果传回面板，回滚乐观更新的刷新间隔。
      return false;
    }
  };

  // 自动模式的汇率：进用量页时过期就取一次，取到后写回设置
  useAutoExchangeRates(
    settings?.usageDisplay,
    (usageDisplay) => save({ usageDisplay }),
    settings != null,
  );

  const navigation = (
    <PageTabs
      className="shrink-0 px-6"
      aria-label={t("unifiedUsage.views", { defaultValue: "Usage views" })}
      items={[
        {
          value: "device" as const,
          label: t("unifiedUsage.deviceActivity", {
            defaultValue: "Device activity",
          }),
        },
        {
          value: "accounts" as const,
          label: t("unifiedUsage.accountAnalytics", {
            defaultValue: "Account analytics",
          }),
        },
      ]}
      value={view}
      onValueChange={setView}
    />
  );

  if (view === "accounts")
    return <UnifiedUsageDashboard navigation={navigation} />;

  return (
    <UsageDashboard
      navigation={navigation}
      refreshIntervalMs={settings?.usageDashboardRefreshIntervalMs}
      onRefreshIntervalChange={(usageDashboardRefreshIntervalMs) =>
        save({ usageDashboardRefreshIntervalMs })
      }
      sessionAutoSyncEnabled={settings?.sessionAutoSyncEnabled ?? true}
      settingsReady={settings != null}
      onSessionAutoSyncEnabledChange={(sessionAutoSyncEnabled) =>
        save({ sessionAutoSyncEnabled })
      }
      initialAppType={initialAppType}
      onOpenRoutingSettings={onOpenRoutingSettings}
      usageDisplay={settings?.usageDisplay}
      onUsageDisplayChange={(usageDisplay) => save({ usageDisplay })}
    />
  );
}
