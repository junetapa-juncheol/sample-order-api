CREATE TABLE IF NOT EXISTS products (
  id integer PRIMARY KEY,
  name text NOT NULL,
  price integer NOT NULL CHECK (price > 0),
  stock integer NOT NULL CHECK (stock >= 0),
  category text NOT NULL
);
CREATE TABLE IF NOT EXISTS orders (
  id uuid PRIMARY KEY,
  pickup_code text NOT NULL,
  request_key text NOT NULL UNIQUE,
  status text NOT NULL DEFAULT 'received' CHECK (status IN ('received','preparing','ready','collected')),
  total integer NOT NULL CHECK (total > 0),
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS order_items (
  order_id uuid NOT NULL REFERENCES orders(id),
  product_id integer NOT NULL REFERENCES products(id),
  quantity integer NOT NULL CHECK (quantity > 0),
  unit_price integer NOT NULL CHECK (unit_price > 0),
  PRIMARY KEY (order_id, product_id)
);
CREATE TABLE IF NOT EXISTS order_outbox (
  id uuid PRIMARY KEY,
  order_id uuid NOT NULL REFERENCES orders(id),
  kind text NOT NULL,
  payload jsonb NOT NULL,
  delivered boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);
INSERT INTO products (id,name,price,stock,category) VALUES
  (1,'소금 버터롤',3200,36,'식사빵'),
  (2,'아몬드 크루아상',4800,18,'페이스트리'),
  (3,'올리브 치아바타',4200,24,'식사빵'),
  (4,'레몬 파운드',3800,16,'구움과자')
ON CONFLICT (id) DO NOTHING;
