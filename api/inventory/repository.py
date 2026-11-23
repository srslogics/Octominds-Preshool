"""Inventory queries and serialized stock mutations on libSQL."""
import json
from datetime import UTC, datetime, time, timedelta
from decimal import Decimal, ROUND_HALF_UP
from uuid import uuid4
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..turso.db import now
from ..turso.repository import SchoolRepository
from ..turso.school import save_record
from .errors import InventoryError

SCALES = {'reorder_level': 1000, 'quantity': 1000, 'signed_quantity': 1000, 'quantity_on_hand': 1000,
          'quantity_before': 1000, 'quantity_after': 1000, 'standard_cost': 100, 'unit_cost': 100,
          'average_unit_cost': 100}
MAX_STORED = 10**14-1


def scaled(values):
    return {key: int(Decimal(str(value))*SCALES[key]) if key in SCALES and value is not None else value
            for key,value in values.items()}


def unscaled(row):
    return {k: v/SCALES[k] if k in SCALES and v is not None else v for k,v in row.items()}


def require_write(access, branch):
    if not access.inventory(branch, True):
        raise InventoryError('inventory_access_denied','You cannot change stock at this center.',403)


def scope(access, branch):
    branches = [key for key in access.branches if (not branch or key==branch) and access.inventory(key)]
    return f"branch_id in ({','.join('?' for _ in branches)})", branches


def item_at(access, branch, item_id):
    result = access.db.one('select * from inventory_items where id=? and branch_id=? and is_active=1',(item_id,branch))
    if not result:
        raise InventoryError('inventory_item_not_found','The selected item is unavailable.',404)
    return result


def require_location(db, branch, location):
    if not db.scalar('select 1 from inventory_locations where id=? and branch_id=? and is_active=1',(location,branch)):
        raise InventoryError('inventory_location_not_found','The selected location is unavailable.',404)


def get_balance(db, item, location):
    return db.one('select quantity_on_hand,average_unit_cost from inventory_stock_balances where item_id=? and location_id=?',
                  (item,location)) or {'quantity_on_hand':0,'average_unit_cost':None}


def weighted(before, old_cost, incoming, cost):
    if cost is None:
        return old_cost
    numerator = before*(old_cost if old_cost is not None else cost) + incoming*cost
    return int((Decimal(numerator)/Decimal(before+incoming)).quantize(Decimal('1'),rounding=ROUND_HALF_UP))


def record_movement(access, data, location, kind, delta, balance, cost=None, group=None, key=None):
    db=access.db
    branch,item=data['branch_id'],data['item_id']
    before=balance['quantity_on_hand']
    after=before+delta
    if after<0:
        raise InventoryError('insufficient_stock','There is not enough stock for this movement.',409)
    if after>MAX_STORED:
        raise InventoryError('invalid_inventory_quantity','The stock balance would exceed its allowed range.',422)
    average=weighted(before,balance['average_unit_cost'],delta,cost) if delta>0 else balance['average_unit_cost']
    db.execute("""
        insert into inventory_stock_balances(branch_id,location_id,item_id,quantity_on_hand,average_unit_cost,version,updated_at)
        values (?,?,?,?,?,1,?) on conflict(location_id,item_id) do update set
        quantity_on_hand=excluded.quantity_on_hand,average_unit_cost=excluded.average_unit_cost,
        version=inventory_stock_balances.version+1,updated_at=excluded.updated_at
        """,(branch,location,item,after,average,now()))
    return db.insert('inventory_movements', {'branch_id':branch,'location_id':location,'item_id':item,
        'movement_type':kind,'quantity':abs(delta),'signed_quantity':delta,'quantity_before':before,'quantity_after':after,
        'unit_cost':cost,'reference':data.get('reference'),'notes':data.get('notes'),'transfer_group_id':group,
        'idempotency_key':key,'posted_by':access.actor,'posted_at':now()})


def movement_rows(db, where, args, limit, offset):
    rows = db.all(f"""select m.id,m.branch_id,m.movement_type,m.quantity,m.signed_quantity,m.quantity_after,m.reference,m.notes,
        m.posted_at,i.name item_name,i.sku,i.unit,l.name location_name from
        (select * from inventory_movements where {where} order by posted_at desc,id desc limit ? offset ?) m
        join inventory_items i on i.id=m.item_id join inventory_locations l on l.id=m.location_id
        order by m.posted_at desc,m.id desc""", [*args, limit, offset])
    return [unscaled(row) for row in rows]


class InventoryRepository(SchoolRepository):
    def lookups(self, branch_id):
        with self.access() as access:
            where,args=scope(access,branch_id)
            return {
                'branches':[{'id':b, 'name':access.branches[b]['name'], 'code':access.branches[b]['code']}
                            for b in sorted((key for key in access.branches if access.inventory(key)),
                                            key=lambda key:(access.branches[key]['name'],key))],
                'categories':access.db.all('select id,branch_id,name,code from inventory_categories where is_active=1 and '+where+' order by name,id',args),
                'locations':access.db.all('select id,branch_id,name,code,location_type from inventory_locations where is_active=1 and '+where+' order by name,id',args),
                'items':access.db.all('select id,branch_id,name,sku,unit from inventory_items where is_active=1 and '+where+' order by name,id',args)
            }

    def create_center(self,data):
        with self.access(write=True) as access:
            return save_record(access,'centers',data)

    def list_items(self,branch_id,search,stock_status,page,page_size,item_id=None):
        with self.access() as access:
            where,args=scope(access,branch_id)
            if item_id:
                where += ' and id=?'
                args.append(item_id)
            db=access.db
            sql=f"""with scoped as (select * from inventory_items where is_active=1 and {where}),
                quantities as (select s.item_id,sum(s.quantity_on_hand) quantity from inventory_stock_balances s
                   join scoped i on i.id=s.item_id group by s.item_id),
                items as (select i.*,c.name category_name,coalesce(q.quantity,0) quantity_on_hand,
                  case when coalesce(q.quantity,0)<=0 then 'out' when q.quantity<=i.reorder_level then 'low' else 'healthy' end stock_status
                  from scoped i join inventory_categories c on c.id=i.category_id left join quantities q on q.item_id=i.id
                  where instr(lower(i.name),lower(?))>0 or instr(lower(i.sku),lower(?))>0)
                """
            params=[*args,search,search,stock_status,stock_status]
            condition=" where (?='all' or stock_status=?)"
            total=db.scalar(sql+' select count(*) from items'+condition,params)
            rows=db.all(sql+' select * from items'+condition+' order by name,id limit ? offset ?',
                        [*params,page_size,(page-1)*page_size])
            ids=[row['id'] for row in rows]
            balances={key:[] for key in ids}
            if ids:
                slots=','.join('?' for _ in ids)
                for b in db.all(f"""select s.item_id,s.location_id,s.quantity_on_hand,l.name from inventory_stock_balances s
                        join inventory_locations l on l.id=s.location_id where s.item_id in ({slots}) order by l.name,s.location_id""",ids):
                    balances[b['item_id']].append({'location_id':b['location_id'],'quantity_on_hand':b['quantity_on_hand']/1000,
                                                   'inventory_locations':{'name':b['name']}})
            items=[]
            for row in rows:
                parts=balances[row['id']]
                items.append({**unscaled(row),'balances':parts,'location_names':list(dict.fromkeys(p['inventory_locations']['name'] for p in parts))})
            return {'items':items,'total':total,'page':page,'page_size':page_size}

    def dashboard(self, branch_id, *, include_overview=False):
        with self.access() as access:
            db=access.db
            where,branches=scope(access,branch_id)
            quantities = f"""with scoped as (
                select id,name,unit,reorder_level from inventory_items where is_active=1 and {where}
            ), quantities as (
                select i.id,i.name,i.unit,i.reorder_level,coalesce(sum(s.quantity_on_hand),0) quantity
                from scoped i left join inventory_stock_balances s on s.item_id=i.id group by i.id
            )"""
            restock = """,
                (select json_group_array(json_object('name',name,'unit',unit,'quantity_on_hand',quantity,
                    'stock_status',case when quantity<=0 then 'out' else 'low' end))
                 from (select name,unit,quantity from quantities where quantity<=0 or quantity<=reorder_level
                       order by (quantity>0),name,id limit 5)) restock_items""" if include_overview else ''
            result = db.one(quantities + f"""
                select count(*) active_items, count(*) filter(where quantity>0 and quantity<=reorder_level) low_stock,
                count(*) filter(where quantity<=0) out_of_stock {restock} from quantities
                """, branches)
            movements=0
            for branch in branches:
                try:
                    tz=ZoneInfo(access.branches[branch]['timezone'])
                except (ZoneInfoNotFoundError,ValueError):
                    tz=ZoneInfo('Asia/Kolkata')
                today=datetime.now(tz).date()
                intervals=[datetime.combine(day,time.min,tz).astimezone(UTC).isoformat() for day in (today,today+timedelta(days=1))]
                movements+=db.scalar('select count(*) from inventory_movements where branch_id=? and posted_at>=? and posted_at<?',
                                     [branch,*intervals])
            result['movements_today'] = movements
            if include_overview:
                result['restock_items'] = [unscaled(item) for item in json.loads(result['restock_items'])]
                result['recent_movements'] = movement_rows(db, where, branches, 6, 0)
            return result

    def list_movements(self,branch_id,limit,offset,movement_type):
        with self.access() as access:
            where,args=scope(access,branch_id)
            if movement_type=='transfer':
                where+=" and movement_type in ('transfer_in','transfer_out')"
            elif movement_type!='all':
                where+=' and movement_type=?'
                args.append(movement_type)
            db=access.db
            total=db.scalar('select count(*) from inventory_movements where '+where,args)
            return {'movements':movement_rows(db, where, args, limit, offset),'total':total}

    def create_row(self,table,data):
        if table not in {'inventory_categories','inventory_locations','inventory_items'}:
            raise ValueError('Invalid inventory table')
        with self.access(write=True) as access:
            require_write(access,data['branch_id'])
            values={**scaled(data),'created_by':access.actor}
            result=access.db.insert(table,values)
            access.audit('inventory.record_created',table,result['id'],data['branch_id'])
            return unscaled(result)

    def update_item(self,item_id,branch_id,data):
        with self.access(write=True) as access:
            require_write(access,branch_id)
            db=access.db
            old=db.one('select * from inventory_items where id=? and branch_id=?',(item_id,branch_id))
            if not old:
                raise InventoryError('inventory_item_not_found','Item is unavailable.',404)
            if data.get('unit',old['unit'])!=old['unit'] and db.scalar('select 1 from inventory_movements where item_id=?',(item_id,)):
                raise InventoryError('inventory_unit_has_history','Create a new item to change units after posting stock.',409)
            if data.get('is_active') is False and db.scalar('select 1 from inventory_stock_balances where item_id=? and quantity_on_hand<>0',(item_id,)):
                raise InventoryError('inventory_item_has_stock','Move or issue all stock before archiving.',409)
            result=db.update('inventory_items',item_id,{**scaled(data),'updated_at':now()})
            access.audit('inventory.item_updated','inventory_items',item_id,branch_id)
            return unscaled(result)

    def stock_command(self,operation,values):
        data=scaled(values)
        key=data.pop('idempotency_key').strip()
        if len(key)<8:
            raise InventoryError('invalid_inventory_idempotency_key','A valid command identifier is required.',422)
        branch,item=data['branch_id'],data['item_id']
        for field in ('notes','reference'):
            data[field]=(data.get(field) or '').strip() or None
        if operation=='movement':
            data.setdefault('unit_cost',None)
        quantity=data['quantity']
        if quantity<=0 or quantity>999999999999:
            raise InventoryError('invalid_inventory_quantity','Choose a stock quantity within the supported range.',422)
        payload=json.dumps(data,sort_keys=True,separators=(',',':'))
        with self.access(write=True) as access:
            require_write(access,branch)
            db=access.db
            previous=db.one('select * from inventory_commands where actor_id=? and command_key=?',(access.actor,key))
            if previous:
                if previous['operation']!=operation or previous['payload']!=payload:
                    raise InventoryError('inventory_idempotency_conflict','This identifier was already used for different stock details.',409)
                return json.loads(previous['result'])
            item_at(access,branch,item)
            if operation=='movement':
                location,kind=data['location_id'],data['movement_type']
                require_location(db,branch,location)
                balance=get_balance(db,item,location)
                if kind=='opening_balance' and (balance['quantity_on_hand'] or db.scalar(
                        'select 1 from inventory_movements where item_id=? and location_id=?',(item,location))):
                    raise InventoryError('opening_balance_already_exists','Opening balance is only available before the first movement.',409)
                delta=-quantity if kind in ('issue','adjustment_loss') else quantity
                movement=record_movement(access,data,location,kind,delta,balance,data['unit_cost'],key=key)
                result={'movement_id':movement['id'],'quantity_after':movement['quantity_after']/1000}
                access.audit('inventory.movement_posted','inventory_movement',movement['id'],branch)
            else:
                source,target=data['from_location_id'],data['to_location_id']
                if source==target:
                    raise InventoryError('inventory_transfer_same_location','Choose different locations.',422)
                require_location(db,branch,source)
                require_location(db,branch,target)
                source_balance,target_balance=get_balance(db,item,source),get_balance(db,item,target)
                group=str(uuid4())
                out=record_movement(access,data,source,'transfer_out',-quantity,source_balance,source_balance['average_unit_cost'],group,key+':out')
                into=record_movement(access,data,target,'transfer_in',quantity,target_balance,source_balance['average_unit_cost'],group,key+':in')
                result={'transfer_group_id':group,'from_quantity_after':out['quantity_after']/1000,'to_quantity_after':into['quantity_after']/1000}
                access.audit('inventory.stock_transferred','inventory_transfer',group,branch)
            db.insert('inventory_commands',{'actor_id':access.actor,'command_key':key,'operation':operation,
                      'payload':payload,'result':json.dumps(result)},generate_id=False)
            return result
