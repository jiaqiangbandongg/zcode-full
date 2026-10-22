import { useState } from "react";
import { createRoot } from "react-dom/client";
import { Collapsible as Primitive } from "radix-ui";
import { ZCodeIntlProvider } from "@/i18n/IntlProvider.js";
import { ToolLayout } from "@/ToolCallBlocks/ToolLayout.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from "@/components/ui/accordion.js";
import "@/styles.css";

const query = new URLSearchParams(location.search);
const theme = query.get("theme") === "light" ? "light" : "dark";
document.documentElement.className = `${theme} theme-zai-${theme}`;

function Fixture() {
  const [mounted, setMounted] = useState(false);
  const [narrow, setNarrow] = useState(false);
  const [special, setSpecial] = useState(false);
  const [running, setRunning] = useState(true);
  return (
    <ZCodeIntlProvider initialLocale={query.get("mobile") === "true" ? "en-US" : "zh-CN"}>
      <TooltipProvider>
        <div className="h-dvh overflow-auto bg-background text-foreground text-ui-base">
          <nav className="sticky top-0 z-10 flex flex-wrap gap-2 bg-background">
            <button onClick={() => setMounted((value) => !value)}>Mount</button>
            <button onClick={() => setNarrow((value) => !value)}>Width</button>
            <button onClick={() => setSpecial(true)}>Special</button>
            <button onClick={() => setRunning(false)}>Complete</button>
          </nav>
          <main
            data-testid="tools"
            data-mounted={mounted}
            style={{ width: narrow ? "70%" : "100%", transition: "width 200ms ease" }}
          >
            {mounted &&
              Array.from({ length: 134 }, (_, index) => (
                <ToolLayout
                  key={index}
                  toolId={`measurement-${index}`}
                  icon={<span>•</span>}
                  kindLabel="Tool"
                  primaryText={`历史工具 ${index}`}
                  renderContent={() => (
                    <div data-testid={`detail-${index}`}>
                      <p>{"完整详情必须保留。 Details remain available. ".repeat(6)}</p>
                      <input aria-label={`note-${index}`} defaultValue="detail" />
                      {index === 0 && (
                        <ToolLayout
                          toolId="measurement-nested"
                          icon={<span>•</span>}
                          kindLabel="Nested"
                          primaryText="子工具"
                          renderContent={() => <p data-testid="nested-detail">Nested detail</p>}
                        />
                      )}
                    </div>
                  )}
                />
              ))}
          </main>
          {special && (
            <section data-testid="special">
              <Primitive.Root defaultOpen>
                <Primitive.Trigger>Default open</Primitive.Trigger>
                <Primitive.Content data-testid="default-content">Default detail</Primitive.Content>
              </Primitive.Root>
              <Primitive.Root>
                <Primitive.Trigger>Force mount</Primitive.Trigger>
                <Primitive.Content forceMount data-testid="force-content">
                  Forced detail
                </Primitive.Content>
              </Primitive.Root>
              <Primitive.Root disabled>
                <Primitive.Trigger>Disabled</Primitive.Trigger>
                <Primitive.Content data-testid="disabled-content">
                  Disabled detail
                </Primitive.Content>
              </Primitive.Root>
              <ToolLayout
                toolId="measurement-auto"
                icon={<span>•</span>}
                kindLabel="Auto"
                primaryText="Auto open"
                autoOpen
                isRunning={running}
                autoCollapseOnComplete
                renderContent={() => <p data-testid="auto-detail">Automatic detail</p>}
              />
              <Accordion type="single" collapsible>
                <AccordionItem value="one">
                  <AccordionTrigger>Accordion</AccordionTrigger>
                  <AccordionContent data-testid="accordion-detail">
                    Accordion detail
                  </AccordionContent>
                </AccordionItem>
              </Accordion>
            </section>
          )}
        </div>
      </TooltipProvider>
    </ZCodeIntlProvider>
  );
}
createRoot(document.getElementById("root")!).render(<Fixture />);
