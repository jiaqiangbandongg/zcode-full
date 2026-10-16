export async function waitForToastContaining(
  expected: string | readonly string[],
  timeoutMsg = "没有等到预期 toast",
) {
  const expectedTexts = Array.isArray(expected) ? expected : [expected];
  let latest: string[] = [];
  await browser.waitUntil(
    async () => {
      latest = await getToastMessages();
      return expectedTexts.some((text) =>
        latest.some((message) => message.includes(text)),
      );
    },
    {
      timeout: 5000,
      timeoutMsg: `${timeoutMsg}; expected=${JSON.stringify(
        expectedTexts,
      )}; latest=${JSON.stringify(latest)}`,
    },
  );
}

export function getToastMessages() {
  return browser.execute(() => {
    const host = document.querySelector("#zcode-toast-host");
    if (!host) {
      return [];
    }
    return Array.from(host.querySelectorAll<HTMLElement>("div"))
      .map((element) => (element.innerText || element.textContent || "").trim())
      .filter(Boolean);
  });
}
