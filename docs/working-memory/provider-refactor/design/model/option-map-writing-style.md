# Option Map 写作风格

> 状态：已裁决；2026-09-09。适用于 Built-in 专用与兜底 Option Map 的编写和评审。
> 本文只规定表达式的写法与展示排版，不规定迁移、历史兼容或功能改造策略。

## 1. 总原则

简化表达式逻辑，但不压缩结构。以设置页文本框中的可读性为准，不以 JSON 配置文件的物理行数为准。

- 嵌套对象按层级展开，统一两空格缩进；兄弟字段分行。
- 简单、非嵌套的三目表达式保持同行，不机械拆成三行。
- 复杂或嵌套条件按分支换行，缩进体现归属；过长时按语义拆分，不依赖文本框软换行体现结构。
- 简单单层对象可以同行，不要求所有 Map 都展开。

```js
{
  "thinking": {
    "type": reasoningLevel == "enabled" ? "enabled" : "disabled"
  }
}
```

简单单层对象：

```js
{"max_tokens": maxOutputTokens}
```

## 2. 条件放在差异处

- 仅字段值不同时，共用对象结构，把条件下沉到对应字段。
- 分支改变字段是否存在或对象结构时，保留对象级分支，不为了少写分支而塞入无关字段。
- 不重复展开几乎相同的完整对象。

需要对象分支时，例如：

```js
reasoningLevel == "disabled"
  ? {
      "thinking": {
        "type": "disabled"
      }
    }
  : {
      "thinking": {
        "type": "adaptive"
      },
      "output_config": {
        "effort": reasoningLevel
      }
    }
```

示例只说明结构写法，不要求所有模型使用这些字段或档位。

## 3. 能透传就透传

当目标字段接受的值与所属 Option 值相同时，直接使用变量，不罗列 `low → low / high → high / max → max` 的同义条件链。关闭状态或接口值不同才做必要转换。

变量使用所属 Option 的正式名称，例如 `reasoningLevel`、`maxOutputTokens`；不引入含混的通用 `value`。

## 4. 排版的归属

- 换行和缩进保存在 Built-in Map 源字符串中；JSON 文件中可以表现为 `\n` 转义。
- GUI 原样展示源字符串，不增加第二套展示格式、Formatter Service 或运行时重排。
- 不自动格式化用户的 Personal Map；打开、查看或取消编辑不能因排版产生个人覆盖或写盘。
- 本规范同时适用于专用 Map 和兜底 Map，与供应商、主题、语言及窗口宽度无关。

## 5. 与改造原则分开

“修改已有规则要保持请求行为等价”“是否迁移旧档位”“是否兼容旧配置”属于对应改造 Todo 的边界，不是写作风格规则。不得把这些内容混成本文的样式要求。

相关：原排版约定见 [Todo66](../../steps/todo-66-option-map-variable-naming-and-display-formatting.md)；本次回归修复见 [Todo98](../../steps/todo-98-builtin-option-map-formatting-regression.md)。
