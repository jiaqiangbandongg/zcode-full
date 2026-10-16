// 递归类型 → $defs/$ref：直接自引用与通过成员间接自引用。
interface TreeNode {
  value: number;
  children: TreeNode[];
}

interface Category {
  name: string;
  parent?: Category;
  items: string[];
}

const g = agent("g");
const tree = await g.ask<TreeNode>("build a tree");
const category = await g.ask<Category>("build a category");
log(JSON.stringify(tree) + JSON.stringify(category));
