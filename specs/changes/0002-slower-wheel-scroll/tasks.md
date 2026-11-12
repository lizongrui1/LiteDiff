# 0002：任务清单

- Status: Implementing
- Related plan: [`plan.md`](plan.md)

| 任务 ID | 任务 | 依赖 | 文件/模块 | 验收方式 | 状态 |
|---|---|---|---|---|---|
| T-01 | 写清根因：一行 20 px，滚轮一格 40–60 px，一次跳 2–3 行 | 无 | `spec.md` | 根因、代码位置与用户症状一一对应 | DONE |
| T-02 | 补回归测试：步长上限、方向、行高回退、手势放行、缓动收敛 | T-01 | `app/tests/wheelScroll.test.ts` | 覆盖 REQ-WHEEL-01..08，`npm test` 通过 | DONE |
| T-03 | 实现 `wheelScroll.ts`（`wheelStepPx` / `wheelDeltaPx` / `clampOffset` / `easeToward` / `rowHeightPx` / `slowWheel`） | T-02 | `app/src/lib/wheelScroll.ts` | 纯函数测试通过 | DONE |
| T-04 | 在两个滚动容器上挂 `use:slowWheel` | T-03 | `DiffPane.svelte`、`UnifiedView.svelte` | 接线测试通过 | DONE |
| T-05 | 同步产品规范 | T-04 | `specs/product/litediff.md` | 新增 `REQ-VIEW-11` 与行为一致 | DONE |
| T-06 | 运行前端门禁并记录证据 | T-04 | `verification.md` | `npm test`、`npm run check`、`npm run build` 结果落盘 | DONE |
| T-07 | 真实窗口人工滚动检查 | T-06 | 分栏 / 统一视图 | 滚轮一格一行、无抖动、跳转不被拽回 | TODO |

状态只使用 `TODO`、`DOING`、`BLOCKED`、`DONE`。被阻塞的任务必须写明原因和下一步。
