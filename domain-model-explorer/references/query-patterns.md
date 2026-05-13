# Query Patterns

## 1. 先缩小范围，再深挖

如果用户没有给出精确节点名，先查上下文，再查节点，再查关系。

推荐顺序：

```bash
node scripts/domain-model-query.mjs list-contexts
node scripts/domain-model-query.mjs summarize-context "OrderContext"
node scripts/domain-model-query.mjs node-detail "PurchaseOrderCreatedEvent"
```

## 2. 查链路时优先轻量过滤

关系查询最容易把结果放大。

默认建议：

- `scope=context`
- `nodeTypes=Event`
- 需要命令再加 `Command`

示例：

```bash
node scripts/domain-model-query.mjs summarize-relations "UserLockedEvent" incoming context Event,Command
```

## 3. 回答用户时先说业务结果

优先输出：

- 发生了什么
- 谁触发了它 / 它触发了谁
- 是否跨上下文
- 技术链路只作为补充

不优先输出：

- 原始请求过程
- 命令历史
- “我先查了什么再查了什么”

## 4. 常见问法映射

- “有哪些限界上下文” -> `list-contexts` / `summarize-contexts`
- “订单上下文里有什么” -> `context-nodes`
- “快速总结一下订单上下文” -> `summarize-context`
- “这个事件详情是什么” -> `node-detail`
- “这个事件会触发什么” -> `node-relations ... outgoing`
- “这个事件是谁发出来的” -> `node-relations ... incoming`
- “帮我概括这个事件的上下游” -> `summarize-relations`
- “会不会影响别的上下文” -> `node-relations ... global`

## 5. 写操作先定位，再变更

默认顺序：

1. 先确认上下文、节点或关系目标
2. 没有精确目标时先查，不要直接改
3. 在真正执行前，先用 Markdown 表格列出本次操作的影响面
4. 表格至少包含：操作、目标、影响节点、参数/字段、规则/注意事项
5. 等用户明确确认后再执行写操作
6. 改节点时优先用节点名或节点 id
7. 改关系时优先先 `list-relations` 拿 relation id
8. 写完后确认最终结果

推荐表格：

| 操作 | 目标 | 影响节点 | 参数/字段 | 规则/注意事项 |
| --- | --- | --- | --- | --- |
| 更新节点 | `PaymentTimedOutEvent` | `PaymentTimedOutEvent` | `displayName: 支付已超时` | 仅修改列出的字段，未列出字段保持不变 |

## 6. 常见写操作映射

- “加一个事件节点” -> `create-node`
- “改这个节点的显示名” -> `update-node`
- “把这个节点移动到另一个上下文” -> `move-node`
- “删除这个节点” -> `delete-node`
- “补一条关系” -> `create-relation`
- “把这条关系标签改一下” -> `update-relation`
- “删掉这条关系” -> `list-relations` -> `delete-relation`

所有这些写操作都要先出影响表，再等用户确认。
