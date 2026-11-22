import { PortraitCutApp } from "./app.ts";
import { ExportController } from "./export-ui.ts";

const app = new PortraitCutApp();
new ExportController(app);
void app.start();

declare global {
  interface Window {
    portraitCut?: PortraitCutApp;
  }
}

window.portraitCut = app;
