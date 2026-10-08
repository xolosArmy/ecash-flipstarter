// Fixture T-10i (P4-L3): código precargado. Deja un marcador en el cwd para demostrar que
// se ejecuta ANTES del guard. No lee ni escribe nada más.
import { writeFileSync } from 'node:fs';
writeFileSync('preload-marker.txt', 'precargado\n');
