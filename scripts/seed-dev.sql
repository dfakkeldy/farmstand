-- Demo data for LOCAL development only (npm run seed:local).
-- It creates no login link: make one with `npm run admin -- link add --seller 1`.
INSERT INTO sellers (id, name, created_at) VALUES (1, 'Hillside Farm', 1767225600000);

INSERT INTO stands (id, seller_id, slug, name, mode, pickup_info, message, created_at) VALUES
  (1, 1, 'hillside', 'Hillside Farm Stand', 'staffed', 'Pick up at the barn door. Open 9 to 5.', 'Strawberries Saturday', 1767225600000),
  (2, 1, 'crossroads', 'Crossroads Honour Stand', 'unattended', 'Baskets go on the left shelf. Usually packed by 5 pm.', '', 1767225600000);

INSERT INTO items (stand_id, name, unit_label, price_cents, stock, sort, created_at, updated_at) VALUES
  (1, 'Eggs', 'dozen', 500, 12, 1, 1767225600000, 1767225600000),
  (1, 'Tomatoes', 'bag', 400, 8, 2, 1767225600000, 1767225600000),
  (1, 'Raw honey', 'jar', 1200, 5, 3, 1767225600000, 1767225600000),
  (2, 'Eggs', 'dozen', 500, 10, 1, 1767225600000, 1767225600000),
  (2, 'Potatoes', 'bag', 600, 6, 2, 1767225600000, 1767225600000),
  (2, 'Garlic', 'bulb', 150, 20, 3, 1767225600000, 1767225600000);
