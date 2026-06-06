const codes = ['2039808202871', '6973914898657', 'DT-301600', 'DT-00229'];
for (const c of codes) {
  console.log(c, c.includes('00229'), c.replace(/\D/g, '') === '00229');
}
