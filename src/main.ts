import "@fontsource/geist-sans/400.css";
import "@fontsource/geist-sans/500.css";
import "@fontsource/geist-sans/600.css";
import "@fontsource/geist-sans/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";
import "./ui/styles/tokens.css";
import "./ui/styles/layout.css";
import "./ui/styles/components.css";
import { mountWorkbenchApp } from "./ui/app";

const root = document.querySelector<HTMLElement>("#app");
if (root) {
  void mountWorkbenchApp(root);
}
