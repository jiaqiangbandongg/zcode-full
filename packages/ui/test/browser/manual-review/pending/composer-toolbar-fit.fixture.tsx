import { useState } from "react";
import { createRoot } from "react-dom/client";
import { useComposerToolbarFit } from "@/prompt-editor/useComposerToolbarFit.js";
import { Button } from "@/components/ui/button.js";
import {
  DropdownMenu,
  DropdownMenuTrigger,
  DropdownMenuContent,
  DropdownMenuItem,
} from "@/components/ui/dropdown-menu.js";
import "@/styles.css";

const params = new URLSearchParams(location.search);
const theme = params.get("theme") === "light" ? "light" : "dark";
const chinese = params.get("locale") === "zh-CN";
document.documentElement.className = `${theme} theme-zai-${theme}`;

function Fixture() {
  const ref = useComposerToolbarFit();
  const [long, setLong] = useState(false);
  return (
    <main className="min-h-dvh bg-background p-3 text-foreground text-ui-base">
      <Button onClick={() => setLong(!long)}>Change label</Button>
      <section data-testid="fit-container" style={{ width: "100%", maxWidth: 900 }}>
        <div ref={ref} data-testid="fit-toolbar" className="group/toolbar flex items-end gap-3">
          <div data-composer-leading-actions className="flex min-w-0 flex-1 items-center">
            <div data-composer-leading-content className="flex shrink-0 items-center gap-1">
              {[0, 1, 2].map((priority) => (
                <Button
                  key={priority}
                  data-composer-collapse-priority={priority}
                  className="group/control shrink-0 data-[composer-compact=true]:w-7 data-[composer-compact=true]:px-0"
                >
                  <span>+</span>
                  <span className="group-data-[composer-compact=true]/control:hidden">
                    {chinese
                      ? ["电脑", "模式", "计划"][priority]
                      : ["Computer", "Mode", "Plan"][priority]}
                  </span>
                </Button>
              ))}
            </div>
          </div>
          <div
            data-composer-trailing-actions
            className="ml-auto flex shrink-0 items-center gap-1.5"
          >
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  data-testid="fit-model"
                  data-composer-combined-model
                  data-composer-collapse-priority="3"
                  className="group/control group-data-[composer-model-icon=true]/toolbar:w-7 group-data-[composer-model-icon=true]/toolbar:px-0"
                >
                  <span>M</span>
                  <span className="group-data-[composer-model-icon=true]/toolbar:hidden">
                    {long ? "Long model name ".repeat(12) : chinese ? "模型" : "Model"}
                  </span>
                  <span className="group-data-[composer-compact=true]/control:hidden">
                    {chinese ? "高" : "High"}
                  </span>
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent>
                <DropdownMenuItem>Model option</DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
            <Button aria-label="Send" size="icon-md">
              ↑
            </Button>
          </div>
        </div>
      </section>
    </main>
  );
}

createRoot(document.getElementById("root")!).render(<Fixture />);
