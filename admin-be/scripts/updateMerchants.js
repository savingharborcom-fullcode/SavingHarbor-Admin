// run: node fix.js
import { supabase } from '../dbhelper/dbclient.js';

let offset = 0;
const batch = 500;

while (true) {
  const { data } = await supabase
    .from('merchants')
    .select('id')
    .order('id')
    .range(offset, offset + batch - 1);

  if (!data?.length) break;

  const ids = data.map(r => r.id);
  await supabase.from('merchants').update({ coupon_h2_blocks: [] }).in('id', ids);
  console.log(`Updated ${offset + ids.length}`);
  offset += batch;
}

console.log('Done');