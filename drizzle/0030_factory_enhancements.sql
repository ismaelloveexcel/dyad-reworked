ALTER TABLE `factory_runs` ADD `status` text NOT NULL DEFAULT 'DECIDED';
ALTER TABLE `factory_runs` ADD `fingerprint` text;
ALTER TABLE `factory_runs` ADD `launch_outcome` text;
ALTER TABLE `factory_runs` ADD `prompt_version` text;
ALTER TABLE `factory_runs` ADD `prompt_hash` text;
