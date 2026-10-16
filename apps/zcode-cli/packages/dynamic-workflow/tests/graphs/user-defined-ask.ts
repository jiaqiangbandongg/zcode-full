// A user object with its own `.ask` method must NOT register as an ask site:
// site detection resolves the callee symbol to the facade, not by method name.
const notAnAgent = {
  ask(question: string): string {
    return question.toUpperCase();
  },
};

const shouted = notAnAgent.ask("hello");
const real = await agent("scanner").ask<string>(`Answer, given ${shouted}`);
return real;
