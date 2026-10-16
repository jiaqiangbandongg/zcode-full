// Gen UI parameter-control runtime; see the Visualize LICENSE.md.
/* oxlint-disable max-lines -- Keep parameter binding and registration lifecycle in one runtime. */
// The annotations callback is private to this module, not a page tool API.
export function installGenUiTweakRuntime(callTool) {
  const panels = new Map();
  const targetIds = new WeakMap();
  let nextPanelId = 0;
  let nextTargetId = 0;
  let stopped = false;
  let command = null;
  let previews = new Map();

  const send = (message) =>
    Promise.resolve()
      .then(() => callTool("__zcode_visualization_annotations__", message))
      .catch(() => null);
  const liveTarget = (panel) => {
    const target = panel.target.deref();
    return target?.isConnected && target.ownerDocument === document
      ? target
      : null;
  };

  function owners() {
    const result = new Map();
    for (const panel of panels.values()) {
      const target = liveTarget(panel);
      if (target != null && panel.accepted != null) {
        result.set(target, panel);
      }
    }
    return result;
  }

  function isValue(control, value) {
    switch (control.type) {
      case "range":
        return (
          Number.isFinite(value) && value >= control.min && value <= control.max
        );
      case "color":
        return (
          typeof value === "string" &&
          /^#(?:[\da-f]{3}|[\da-f]{4}|[\da-f]{6}|[\da-f]{8})$/i.test(value)
        );
      case "toggle":
        return typeof value === "boolean";
      case "select":
        return (
          typeof value === "string" &&
          control.options.some((option) => option.value === value)
        );
      default:
        return false;
    }
  }

  function setValue(binding, value) {
    if (liveTarget(binding.panel) == null) {
      return;
    }
    try {
      if (binding.object[binding.property] === value) {
        return;
      }
      binding.object[binding.property] = value;
      binding.panel.onChange?.();
    } catch (error) {
      globalThis.reportError(error);
    }
  }

  function syncPreviews() {
    const desired = new Map();
    const activeOwners = owners();
    for (const change of command?.changes ?? []) {
      const panel = panels.get(change.registrationId);
      if (
        panel == null ||
        panel.targetId !== change.targetId ||
        activeOwners.get(liveTarget(panel)) !== panel
      ) {
        continue;
      }
      // Globals may precede an update's acknowledgement. Keep accepted previews
      // while adding bindings, without recapturing their edited values.
      if (panel.inFlight) {
        for (const [binding, value] of previews) {
          if (binding.panel === panel) {
            desired.set(binding, value);
          }
        }
        continue;
      }
      for (const edit of change.annotationControlChanges) {
        const binding = panel.bindings.get(edit.callback);
        const control = panel.accepted.find(
          (candidate) => candidate.callback === edit.callback,
        );
        if (
          binding != null &&
          control != null &&
          edit.previousValue === control.currentValue &&
          edit.value !== control.currentValue &&
          isValue(control, edit.value)
        ) {
          desired.set(binding, edit.value);
        }
      }
    }
    const previous = previews;
    previews = desired;
    for (const [binding] of previous) {
      if (previews !== desired) {
        return;
      }
      if (!desired.has(binding)) {
        setValue(binding, binding.control.currentValue);
      }
    }
    for (const [binding, value] of desired) {
      // onChange can synchronously dispose a panel or register another one.
      if (previews !== desired) {
        return;
      }
      if (previous.get(binding) !== value) {
        setValue(binding, value);
      }
    }
  }

  function targetSnapshot(panel) {
    const target = liveTarget(panel);
    if (target == null) {
      throw new TypeError("Tweak container is unavailable");
    }
    const parts = [];
    for (
      let element = target;
      element != null && parts.length < 12;
      element = element.parentElement
    ) {
      const id = element.id && globalThis.CSS?.escape?.(element.id);
      if (id && id.length < 256) {
        parts.unshift(`#${id}`);
        break;
      }
      let index = 1;
      for (
        let sibling = element.previousElementSibling;
        sibling != null;
        sibling = sibling.previousElementSibling
      ) {
        if (sibling.localName === element.localName) {
          index += 1;
        }
      }
      parts.unshift(`${element.localName}:nth-of-type(${index})`);
    }
    const label = [
      target.getAttribute("aria-label"),
      target.getAttribute("title"),
      target.id,
      target.localName,
    ]
      .map((value) =>
        value
          ?.replace(
            // oxlint-disable-next-line no-control-regex -- Match the host metadata bounds.
            /[\u0000-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/gu,
            " ",
          )
          .replace(/\s+/g, " ")
          .trim(),
      )
      .find((value) => value);
    const { x, y, width, height } = target.getBoundingClientRect();
    return {
      id: panel.targetId,
      label: label.slice(0, 80),
      selector: parts.join(" > ").slice(0, 1024),
      tagName: target.localName.toLowerCase(),
      rect: { x, y, width, height },
    };
  }

  function dispose(panel) {
    if (panel.disposed) {
      return;
    }
    panel.disposed = true;
    if (panels.delete(panel.id)) {
      syncPreviews();
      void panel.pending.then(() =>
        send({ type: "dispose", registrationId: panel.id }),
      );
    }
    panel.bindings.clear();
    panel.controls = [];
    panel.accepted = null;
  }

  function queue(panel, control, target) {
    panel.pending = panel.pending.then(async () => {
      if (panel.disposed || stopped) {
        return;
      }
      if (liveTarget(panel) == null) {
        dispose(panel);
        return;
      }
      // Rejected bindings must not leak into additions that are already queued.
      const type = panel.accepted == null ? "register" : "update";
      panel.inFlight = true;
      const result = await send({
        type,
        registrationId: panel.id,
        annotationControls: {
          controlsMode: "replace",
          controls: [...(panel.accepted ?? []), control],
        },
        targets: [target],
      });
      panel.inFlight = false;
      if (panel.disposed) {
        return;
      }
      if (Array.isArray(result?.annotationControls?.controls)) {
        panel.accepted = result.annotationControls.controls;
      } else {
        panel.controls = panel.controls.filter(
          (candidate) => candidate.callback !== control.callback,
        );
        panel.bindings.delete(control.callback);
        if (type === "register") {
          dispose(panel);
          return;
        }
      }
      syncPreviews();
    });
  }

  // Object bindings and the sandbox bridge; the host owns all controls UI.
  globalThis.Tweak = class Tweak {
    #panel;
    #disposed = false;

    constructor({ container, onChange }) {
      if (!this.supported) {
        return;
      }
      if (
        !(container instanceof Element) ||
        container.ownerDocument !== document
      ) {
        throw new TypeError("Tweak needs a component element as its container");
      }
      let targetId = targetIds.get(container);
      if (targetId == null) {
        targetId = String(++nextTargetId);
        targetIds.set(container, targetId);
      }
      this.#panel = {
        id: `tweak-${++nextPanelId}`,
        targetId,
        target: new WeakRef(container),
        onChange,
        bindings: new Map(),
        nextControlId: 0,
        controls: [],
        accepted: null,
        pending: Promise.resolve(),
        inFlight: false,
        disposed: false,
      };
    }

    get supported() {
      return callTool != null && !stopped;
    }

    addSlider(
      object,
      property,
      { min, max, step = 1, unit, label, reference } = {},
    ) {
      return this.#bind(object, property, {
        type: "range",
        label: unit ? `${label ?? property} (${unit})` : (label ?? property),
        reference,
        currentValue: object[property],
        min,
        max,
        step,
      });
    }

    addColorPicker(object, property, { label = property, reference } = {}) {
      return this.#bind(object, property, {
        type: "color",
        label,
        reference,
        currentValue: object[property],
      });
    }

    addToggle(object, property, { label = property, reference } = {}) {
      return this.#bind(object, property, {
        type: "toggle",
        label,
        reference,
        currentValue: object[property],
      });
    }

    addSelect(object, property, { options, label = property, reference }) {
      return this.#bind(object, property, {
        type: "select",
        label,
        reference,
        currentValue: object[property],
        options: options.map((option) =>
          typeof option === "string"
            ? { label: option, value: option }
            : { label: option.label, value: option.value },
        ),
      });
    }

    dispose() {
      this.#disposed = true;
      if (this.#panel != null) {
        dispose(this.#panel);
      }
    }

    #bind(object, property, definition) {
      const panel = this.#panel;
      if (this.#disposed || panel?.disposed) {
        throw new Error("Tweak has been disposed");
      }
      if (!this.supported) {
        return this;
      }
      if (!isValue(definition, definition.currentValue)) {
        throw new TypeError("Tweak bindings require a valid current value");
      }
      if (
        panel.controls.length >= 12 ||
        (!panels.has(panel.id) && panels.size >= 64)
      ) {
        throw new RangeError("Too many Tweak controls");
      }
      const callback = `${panel.id}-${++panel.nextControlId}`;
      const payload = JSON.stringify({
        controlsMode: "replace",
        controls: [...panel.controls, { ...definition, callback }],
      });
      if (payload.length > 16_384) {
        throw new RangeError("Tweak controls exceed the maximum size");
      }
      const annotationControls = JSON.parse(payload);
      const control = annotationControls.controls.at(-1);
      const target = targetSnapshot(panel);
      panel.controls = annotationControls.controls;
      panel.bindings.set(callback, {
        panel,
        object,
        property,
        control,
      });
      panels.set(panel.id, panel);
      queue(panel, control, target);
      return this;
    }
  };

  function onGlobals(event) {
    const globals = event.detail?.globals;
    if (globals == null || !Object.hasOwn(globals, "visualizationAnnotation")) {
      return;
    }
    const next = globals.visualizationAnnotation;
    if (
      next != null &&
      (typeof next.active !== "boolean" ||
        !Array.isArray(next.changes) ||
        next.changes.length > 1024 ||
        next.changes.some(
          (change) =>
            change == null ||
            typeof change.registrationId !== "string" ||
            typeof change.targetId !== "string" ||
            !Array.isArray(change.annotationControlChanges) ||
            change.annotationControlChanges.length > 12 ||
            change.annotationControlChanges.some(
              (edit) => edit == null || typeof edit.callback !== "string",
            ),
        ))
    ) {
      return;
    }
    command = next;
    syncPreviews();
  }

  function close() {
    command = { ...command, active: false };
    void send({ type: "escape" });
  }

  function onPointerEvent(event) {
    if (!command?.active || event.button !== 0 || event.defaultPrevented) {
      return;
    }
    const activeOwners = owners();
    for (const target of event.composedPath()) {
      const panel = activeOwners.get(target);
      if (panel != null) {
        if (event.type === "click") {
          void send({
            type: "select",
            registrationId: panel.id,
            targetId: panel.targetId,
          });
        }
        event.preventDefault();
        event.stopImmediatePropagation();
        return;
      }
    }
    if (event.type === "click") {
      close();
    }
  }

  function onKeyDown(event) {
    if (
      !command?.active ||
      event.key !== "Escape" ||
      event.defaultPrevented ||
      event.isComposing
    ) {
      return;
    }
    event.preventDefault();
    close();
  }

  function onPageHide(event) {
    if (!event.isTrusted) {
      return;
    }
    stopped = true;
    command = null;
    syncPreviews();
    for (const panel of panels.values()) {
      dispose(panel);
    }
    observer.disconnect();
    globalThis.removeEventListener("zcode:set_globals", onGlobals);
    globalThis.removeEventListener("pointerdown", onPointerEvent, true);
    globalThis.removeEventListener("mousedown", onPointerEvent, true);
    globalThis.removeEventListener("click", onPointerEvent, true);
    globalThis.removeEventListener("keydown", onKeyDown);
    globalThis.removeEventListener("pagehide", onPageHide);
  }

  const observer = new MutationObserver(() => {
    for (const panel of panels.values()) {
      if (liveTarget(panel) == null) {
        if (command?.active && command.selection?.registrationId === panel.id) {
          close();
        }
        dispose(panel);
      }
    }
  });
  if (callTool != null) {
    observer.observe(document, { childList: true, subtree: true });
    globalThis.addEventListener("zcode:set_globals", onGlobals);
    globalThis.addEventListener("pointerdown", onPointerEvent, true);
    globalThis.addEventListener("mousedown", onPointerEvent, true);
    globalThis.addEventListener("click", onPointerEvent, true);
    globalThis.addEventListener("keydown", onKeyDown);
    globalThis.addEventListener("pagehide", onPageHide);
    onGlobals({ detail: { globals: globalThis.zcode } });
  }
}
