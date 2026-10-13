// Kleine Polyfills für alte Browser (z. B. iPad Air 1 mit iOS 12 / Safari 12).
// Muss in main.tsx als erstes importiert werden.

type WithReplaceChildren = { replaceChildren?: (...nodes: (Node | string)[]) => void };

function replaceChildren(this: ParentNode, ...nodes: (Node | string)[]) {
  while (this.firstChild) this.removeChild(this.firstChild);
  this.append(...nodes);
}

for (const ctor of [Element, Document, DocumentFragment]) {
  const proto = ctor.prototype as unknown as WithReplaceChildren;
  if (!proto.replaceChildren) proto.replaceChildren = replaceChildren;
}

if (!Promise.allSettled) {
  Promise.allSettled = (<T>(values: Iterable<T | PromiseLike<T>>) =>
    Promise.all(
      Array.from(values, (v) =>
        Promise.resolve(v).then(
          (value) => ({ status: "fulfilled" as const, value }),
          (reason: unknown) => ({ status: "rejected" as const, reason })
        )
      )
    )) as typeof Promise.allSettled;
}

export {};
