import { useEffect, useState } from "react";
import {
  capabilityMapLayoutPromise,
  type CapabilityMapLayout,
} from "@/capability-map/capabilityMapLayout.js";

export function useCapabilityMapLayout() {
  const [layout, setLayout] = useState<CapabilityMapLayout | null>(null);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    void capabilityMapLayoutPromise
      .then((nextLayout) => {
        if (active) {
          setLayout(nextLayout);
        }
      })
      .catch((layoutError: unknown) => {
        if (active) {
          setError(layoutError instanceof Error ? layoutError.message : String(layoutError));
        }
      });
    return () => {
      active = false;
    };
  }, []);

  return { error, layout };
}
