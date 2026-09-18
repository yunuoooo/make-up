import { createRoot } from "react-dom/client";
import "../app/globals.css";
import { MakeupAdvisorApp } from "@/components/makeup-advisor-app";

const root = document.getElementById("root");

if (!root) {
  throw new Error("Missing application root.");
}

createRoot(root).render(<MakeupAdvisorApp />);
