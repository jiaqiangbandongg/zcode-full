import type { ReactNode } from "react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";

export function ComposerTriggerTransition({
  open,
  children,
}: {
  open: boolean;
  children: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  return (
    <span className="relative flex min-w-0 flex-1 items-center overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={open ? "open" : "closed"}
          data-composer-trigger-frame={open ? "open" : "closed"}
          className="relative flex h-[1.3em] w-full min-w-0 items-center gap-1 group-data-[composer-model-icon=true]/toolbar:transform-none! group-data-[composer-model-icon=true]/toolbar:opacity-100!"
          initial={{ y: reducedMotion ? 0 : "0.75em", opacity: reducedMotion ? 1 : 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: reducedMotion ? 0 : "-0.75em", opacity: reducedMotion ? 1 : 0 }}
          transition={{ duration: reducedMotion ? 0 : 0.2, ease: [0.4, 0, 0.2, 1] }}
        >
          {children}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}
