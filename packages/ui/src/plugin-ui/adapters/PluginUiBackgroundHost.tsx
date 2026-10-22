import { useEffect, useRef } from "react";
import { useOptionalPlatform } from "@/hooks/usePlatform.js";
import { useOptionalServices } from "@/hooks/useServices.js";
import { useZCodeIntl } from "@/i18n/IntlProvider.js";
import { attachPluginUiToolResults } from "@/plugin-ui/adapters/pluginUiBackground.js";

export function PluginUiBackgroundHost() {
  const platform = useOptionalPlatform();
  const services = useOptionalServices();
  const { locale } = useZCodeIntl();
  const latestLocale = useRef(locale);
  latestLocale.current = locale;
  useEffect(() => {
    if (!platform || !services) return;
    return attachPluginUiToolResults(services, platform, () => ({
      locale: latestLocale.current,
      theme: document.documentElement.classList.contains("dark") ? "dark" : "light",
    }));
  }, [platform, services]);
  return null;
}
