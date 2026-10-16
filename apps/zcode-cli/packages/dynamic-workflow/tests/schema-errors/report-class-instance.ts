// 类实例不是纯数据（方法与原型都过不了 JSON 边界）—— report 与 ask<T> 同样拒绝。
class Finding {
  constructor(readonly path: string) {}
  describe(): string {
    return this.path;
  }
}

report(new Finding("src/a.ts")); // error
