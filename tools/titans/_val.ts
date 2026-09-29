import { validateTitanDef } from '@/contracts';
import { TITAN_DEFS } from '@/titans';
for (const [id, def] of Object.entries(TITAN_DEFS)) {
  const errs = validateTitanDef(def!);
  console.log(id, errs.length ? errs : 'OK');
}
