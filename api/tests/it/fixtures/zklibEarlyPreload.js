'use strict';
// Precarga (`node -r`) que carga node-zklib ANTES que el piloto: simula una
// captura tardía (los transportes ya tomaron el decodificador original).
require('node-zklib/zklibtcp');
require('node-zklib/zklibudp');
