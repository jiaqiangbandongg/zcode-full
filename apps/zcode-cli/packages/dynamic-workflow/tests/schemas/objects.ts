// object：可选属性排除出 required、嵌套对象、闭合对象 additionalProperties: false。
interface Address {
  city: string;
  zip?: string;
}

interface Person {
  name: string;
  age: number;
  address: Address;
  nickname?: string;
}

const g = agent("g");
const person = await g.ask<Person>("produce a person");
log(JSON.stringify(person));
