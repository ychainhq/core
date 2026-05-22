import { EntityDefinition } from './types';

export const CustomerEntityDef: EntityDefinition = {
  name: 'customer',
  table: 'customers',
  alias: 'c',
  sortPolicy: {
    allowed: {
      created_at:   { physical: 'c.created_at',   type: 'timestamp' },
      updated_at:   { physical: 'c.updated_at',   type: 'timestamp' },
      display_name: { physical: 'c.display_name', type: 'text' },
      status:       { physical: 'c.status',       type: 'enum' },
    },
    default:     { field: 'created_at', direction: 'desc' },
    tieBreaker:  { physical: 'c.id',    direction: 'asc' },
  },
};
