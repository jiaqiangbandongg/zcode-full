# Desktop Coding Plan Upgrade Availability E2E

日期：2026-07-03

## 覆盖目标

模拟 BigModel 账号已登录但没有个人 Coding Plan 权益时，用户从 sidebar 头像菜单的升级入口进入
`Upgrade Coding Plan` 购买页。个人套餐数据来自本地 E2E fixture server，
不访问真实 BigModel / ZCode 后端。

## Case: BigModel 个人套餐全部售罄

| 字段 | 内容 |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan-upgrade-personal-sold-out.test.ts` |
| 数据源 | `BigModel Coding Plan E2E mock server` |
| 状态 | verified |

### Setup

1. E2E 隔离 HOME 写入 BigModel OAuth 凭据，表示账号已登录。
2. 写入 BigModel Coding Plan provider，保持未开通套餐状态。
3. 将 `ZCODE_TEST_BASE_URL` 和 `BIGMODEL_TEST_API_BASE_URL` 指向本地 mock server。
4. `client/configs` 返回 BigModel 个人 Lite / Pro / Max 静态套餐。
5. `pay/batch-preview` 返回同一批个人套餐，且每个 SKU `soldOut=true`。

### Action

1. 打开默认 workspace。
2. 点击 sidebar footer 的账号头像菜单。
3. 点击 `Upgrade Coding Plan` 入口打开购买页。

### Assert

- 页面显示个人套餐分组。
- Lite / Pro / Max 个人套餐按钮均显示“已售罄”。
- 这些按钮处于 disabled 状态，不能进入周期选择页。

## Case: BigModel 个人套餐接口系统繁忙

| 字段 | 内容 |
| --- | --- |
| Spec | `packages/desktop/test/e2e/coding-plan-upgrade-personal-system-busy.test.ts` |
| 数据源 | `BigModel Coding Plan E2E mock server` |
| 状态 | verified |

### Setup

1. E2E 隔离 HOME 写入 BigModel OAuth 凭据，表示账号已登录。
2. 写入 BigModel Coding Plan provider，保持未开通套餐状态。
3. `client/configs` 返回静态个人套餐，确保购买页有可展示卡片。
4. `pay/batch-preview` 返回业务失败并被 service 归一为 `coding_plan_system_busy`。

### Action

1. 打开默认 workspace。
2. 点击 sidebar footer 的账号头像菜单。
3. 点击 `Upgrade Coding Plan` 入口打开购买页。

### Assert

- 页面仍显示静态个人套餐卡，而不是空白或无限 loading。
- Lite / Pro / Max 个人套餐按钮使用按钮专属文案：中文“订阅繁忙”，英文“System busy”。
- 这些按钮处于 disabled 状态，不能进入周期选择页。

## 非覆盖项

- 不覆盖真实支付、二维码、Stripe / PayPal 或团队套餐下单。
- 不覆盖手机 `/remote` replayable 链路；该 case 只验证桌面本地 sidebar 升级入口与购买页 UI。
- 不验证真实线上库存或真实 BigModel 账号权益，避免固定回归受线上状态影响。

## 验证命令

- `pnpm --filter @zcode/desktop typecheck:e2e`
- `pnpm typecheck`
- `pnpm lint`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan-upgrade-personal-sold-out.test.ts`
- `pnpm test:e2e -- --spec ./test/e2e/coding-plan-upgrade-personal-system-busy.test.ts`
