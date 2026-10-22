// A user object with its own `.ask` method must NOT register as an ask site:
// site detection resolves the callee symbol to the facade, not by method name.
const notAnAgent = {
    ask(question) {
        return question.toUpperCase();
    },
};
const shouted = notAnAgent.ask("hello");
const real = await __host.ask("ask#1", __host.createActor("actor#1", "scanner"), `Answer, given ${shouted}`);
return real;
