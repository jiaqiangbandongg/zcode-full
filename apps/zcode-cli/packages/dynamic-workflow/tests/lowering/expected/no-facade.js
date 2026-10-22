const nums = [1, 2, 3, 4];
const total = nums.reduce((a, b) => a + b, 0);
const doubled = nums.map((n) => n * 2);
return { doubled, total };
