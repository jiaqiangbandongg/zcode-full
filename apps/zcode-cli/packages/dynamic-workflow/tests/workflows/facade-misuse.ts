// Facade misuse: ask() takes instructions text, agent() takes a name/persona.
await agent("x").ask<string>(42); // error
await agent(42).ask<string>("ok"); // error
