interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

export interface SidebarPurposeSectionPreferences {
  projectsExpanded: boolean;
  conversationsExpanded: boolean;
  sectionOrder: SidebarPurposeSectionId[];
  sourceGroupExpandedSections?: Record<
    string,
    Partial<Record<SidebarPurposeSectionId, boolean>>
  >;
}

export const SIDEBAR_PURPOSE_SECTION_IDS = ["projects", "conversations"] as const;

export type SidebarPurposeSectionId = (typeof SIDEBAR_PURPOSE_SECTION_IDS)[number];

export const SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY =
  "zcode-sidebar-purpose-section-preferences";

const DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES: SidebarPurposeSectionPreferences = {
  projectsExpanded: true,
  conversationsExpanded: true,
  sectionOrder: [...SIDEBAR_PURPOSE_SECTION_IDS],
};

function getBrowserStorage(): StorageLike | null {
  if (typeof window === "undefined") {
    return null;
  }

  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function getDefaultPreferences(): SidebarPurposeSectionPreferences {
  return {
    ...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES,
    sectionOrder: [...DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.sectionOrder],
  };
}

function normalizeSectionOrder(value: unknown): SidebarPurposeSectionId[] {
  if (!Array.isArray(value) || value.length !== SIDEBAR_PURPOSE_SECTION_IDS.length) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  const sectionIds = new Set(value);
  if (
    sectionIds.size !== SIDEBAR_PURPOSE_SECTION_IDS.length ||
    SIDEBAR_PURPOSE_SECTION_IDS.some((sectionId) => !sectionIds.has(sectionId))
  ) {
    return [...SIDEBAR_PURPOSE_SECTION_IDS];
  }

  return value as SidebarPurposeSectionId[];
}

function normalizeSourceGroupExpandedSections(
  value: unknown,
): SidebarPurposeSectionPreferences["sourceGroupExpandedSections"] {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }

  const normalized = Object.fromEntries(
    Object.entries(value).flatMap(([sourceGroupKey, sections]) => {
      if (
        !sourceGroupKey ||
        !sections ||
        typeof sections !== "object" ||
        Array.isArray(sections)
      ) {
        return [];
      }
      const sectionValue = sections as Record<string, unknown>;
      const normalizedSections = Object.fromEntries(
        SIDEBAR_PURPOSE_SECTION_IDS.flatMap((sectionId) =>
          typeof sectionValue[sectionId] === "boolean"
            ? [[sectionId, sectionValue[sectionId]]]
            : [],
        ),
      );
      return Object.keys(normalizedSections).length > 0
        ? [[sourceGroupKey, normalizedSections]]
        : [];
    }),
  );

  return Object.keys(normalized).length > 0 ? normalized : undefined;
}

function getExpandedFallback(
  preferences: SidebarPurposeSectionPreferences,
  sectionId: SidebarPurposeSectionId,
): boolean {
  return sectionId === "projects"
    ? preferences.projectsExpanded
    : preferences.conversationsExpanded;
}

export function resolveSidebarPurposeSectionExpanded(
  preferences: SidebarPurposeSectionPreferences,
  sectionId: SidebarPurposeSectionId,
  sourceGroupKey?: string,
): boolean {
  if (sourceGroupKey) {
    const sourceValue =
      preferences.sourceGroupExpandedSections?.[sourceGroupKey]?.[sectionId];
    if (typeof sourceValue === "boolean") {
      return sourceValue;
    }
  }
  return getExpandedFallback(preferences, sectionId);
}

export function updateSidebarPurposeSectionExpanded(
  preferences: SidebarPurposeSectionPreferences,
  update: {
    sectionId: SidebarPurposeSectionId;
    expanded: boolean;
    sourceGroupKey?: string;
  },
): SidebarPurposeSectionPreferences {
  const { sectionId, expanded, sourceGroupKey } = update;
  if (!sourceGroupKey) {
    const field =
      sectionId === "projects"
        ? "projectsExpanded"
        : "conversationsExpanded";
    return preferences[field] === expanded
      ? preferences
      : { ...preferences, [field]: expanded };
  }

  const fallback = getExpandedFallback(preferences, sectionId);
  const currentSourceSections =
    preferences.sourceGroupExpandedSections?.[sourceGroupKey];
  const currentExpanded = currentSourceSections?.[sectionId] ?? fallback;
  if (currentExpanded === expanded) {
    return preferences;
  }

  const nextSourceSections = { ...currentSourceSections };
  if (expanded === fallback) {
    delete nextSourceSections[sectionId];
  } else {
    nextSourceSections[sectionId] = expanded;
  }

  const sourceGroupExpandedSections = {
    ...preferences.sourceGroupExpandedSections,
  };
  if (Object.keys(nextSourceSections).length === 0) {
    delete sourceGroupExpandedSections[sourceGroupKey];
  } else {
    sourceGroupExpandedSections[sourceGroupKey] = nextSourceSections;
  }

  return {
    ...preferences,
    sourceGroupExpandedSections:
      Object.keys(sourceGroupExpandedSections).length > 0
        ? sourceGroupExpandedSections
        : undefined,
  };
}

export function reorderSidebarPurposeSections(
  sectionOrder: readonly SidebarPurposeSectionId[],
  activeSectionId: string,
  overSectionId: string,
): SidebarPurposeSectionId[] {
  const currentOrder = normalizeSectionOrder(sectionOrder);
  const activeIndex = currentOrder.indexOf(activeSectionId as SidebarPurposeSectionId);
  const overIndex = currentOrder.indexOf(overSectionId as SidebarPurposeSectionId);
  if (activeIndex === -1 || overIndex === -1 || activeIndex === overIndex) {
    return currentOrder;
  }

  const nextOrder = [...currentOrder];
  const activeSection = nextOrder[activeIndex];
  if (!activeSection) {
    return currentOrder;
  }
  nextOrder.splice(activeIndex, 1);
  nextOrder.splice(overIndex, 0, activeSection);
  return nextOrder;
}

export function readSidebarPurposeSectionPreferences(
  storage: StorageLike | null = getBrowserStorage(),
): SidebarPurposeSectionPreferences {
  try {
    const rawValue = storage?.getItem(SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY);
    if (!rawValue) {
      return getDefaultPreferences();
    }

    const parsed: unknown = JSON.parse(rawValue);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return getDefaultPreferences();
    }

    const value = parsed as Partial<SidebarPurposeSectionPreferences>;
    const sourceGroupExpandedSections = normalizeSourceGroupExpandedSections(
      value.sourceGroupExpandedSections,
    );
    return {
      projectsExpanded:
        typeof value.projectsExpanded === "boolean"
          ? value.projectsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.projectsExpanded,
      conversationsExpanded:
        typeof value.conversationsExpanded === "boolean"
          ? value.conversationsExpanded
          : DEFAULT_SIDEBAR_PURPOSE_SECTION_PREFERENCES.conversationsExpanded,
      sectionOrder: normalizeSectionOrder(value.sectionOrder),
      ...(sourceGroupExpandedSections ? { sourceGroupExpandedSections } : {}),
    };
  } catch {
    return getDefaultPreferences();
  }
}

export function persistSidebarPurposeSectionPreferences(
  preferences: SidebarPurposeSectionPreferences,
  storage: StorageLike | null = getBrowserStorage(),
) {
  try {
    const sourceGroupExpandedSections = normalizeSourceGroupExpandedSections(
      preferences.sourceGroupExpandedSections,
    );
    storage?.setItem(
      SIDEBAR_PURPOSE_SECTION_PREFERENCES_STORAGE_KEY,
      JSON.stringify({
        projectsExpanded: preferences.projectsExpanded,
        conversationsExpanded: preferences.conversationsExpanded,
        sectionOrder: normalizeSectionOrder(preferences.sectionOrder),
        ...(sourceGroupExpandedSections ? { sourceGroupExpandedSections } : {}),
      }),
    );
  } catch {
    // 受限 WebView 或隐私模式可能禁止写 localStorage；偏好写入失败不能阻断侧栏交互。
  }
}
