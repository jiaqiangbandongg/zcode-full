# Coding Plan Enterprise Tier I18n

## Background

Team Plan products arrive from enterprise pricing with a technical `tier`
such as `LITE`, `PRO`, or `MAX`. UI surfaces previously translated these tiers
inside TypeScript helpers, which made Chinese names appear as fixed literals and
made future tier naming changes harder to localize.

## Spec

- Team plan tier names are localized through message ids under
  `settings.modelProvider.codingPlan.enterprise.tier.*`.
- Known tiers map to locale copy for `LITE`, `PRO`, and `MAX`.
- Unknown tiers keep a readable formatted fallback derived from the backend
  value, so newly added backend tiers remain visible before locale copy is
  added.
- Team plan status cards use the same team display name as the connection mode
  entry. If a project or organization name exists, that name takes precedence
  over the generic tier name.

## Affected Surfaces

- Model Settings connection mode options
- Team Plan entry banners
- Team Plan purchase panel cards and configuration title
- Team Plan status card title
