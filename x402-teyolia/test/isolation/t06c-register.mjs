// PR-6 T-06c: --import de la prueba; registra t06c-hooks.mjs antes de cargar la app.
import { register } from 'node:module';
register('./t06c-hooks.mjs', import.meta.url);
