// oxlint-disable-next-line typescript/no-unnecessary-type-parameters -- the caller names the element type it expects
export const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;
