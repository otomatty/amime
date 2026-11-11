/**
 * jsdom が実装していないブラウザのAPIを補う。
 * テストで呼び出しを確かめたいときは vi.spyOn で差し替える。
 */
Element.prototype.scrollIntoView = () => {};
