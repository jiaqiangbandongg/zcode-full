import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ModelConfigSelect } from "@/ModelConfigSelect.js";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
document.documentElement.className =
  params.get("theme") === "light" ? "light theme-zai-light" : "dark theme-zai-dark";
const name =
  params.get("name") === "short"
    ? "GLM"
    : params.get("name") === "extreme"
      ? `GLM-${"LongModelName".repeat(20)}`
      : "GLM-5.3-Highspeed";
function Fixture() {
  const [selected, setSelected] = useState("text");
  return (
    <ZCodeIntlProvider initialLocale="en-US">
      <div className="p-8">
        <ModelConfigSelect
          modelGroups={[
            {
              key: "custom",
              label: "Custom provider",
              items: [
                { key: "text", value: "text", name },
                { key: "vision", value: "vision", name, supportsVisionInput: true },
              ],
            },
          ]}
          normalizedValue={selected}
          triggerLabel="Models"
          triggerAriaLabel="Models"
          showManageModelsAction={false}
          lockReasonMessage=""
          isItemLocked={() => false}
          onValueChange={setSelected}
          focusSelectorOnClose={null}
          providerSubmenuClassName={
            innerWidth < 600
              ? "w-40 min-w-0 max-w-(--radix-dropdown-menu-content-available-width)"
              : undefined
          }
        />
        <output data-testid="selected">{selected}</output>
      </div>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
