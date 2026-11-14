// The invite as a QR code: an SVG built with DOM calls, since the CSP allows no inline styles.
import { encode } from "uqr";

const SVG_NS = "http://www.w3.org/2000/svg";

const svgElement = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number>) => {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, String(value));

  return element;
};

/** Dark modules on white in both themes, with the 4-module quiet zone scanners expect. */
export function qrSvg(text: string): SVGSVGElement {
  const { data, size } = encode(text, { border: 4 });
  let path = "";
  data.forEach((row, y) => row.forEach((dark, x) => dark && (path += `M${x} ${y}h1v1h-1z`)));

  const svg = svgElement("svg", {
    viewBox: `0 0 ${size} ${size}`,
    "shape-rendering": "crispEdges",
    "aria-hidden": "true",
  });
  svg.append(
    svgElement("rect", { width: size, height: size, fill: "#fff" }),
    svgElement("path", { d: path, fill: "#000" }),
  );

  return svg;
}
