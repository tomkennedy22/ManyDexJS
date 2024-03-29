import fs from "fs/promises";
import path from "path";
import { type_partition, type_partition_index } from "./types";
import { deep_copy, get_from_dict, partition_name_from_partition_index } from "./utils";
import { compress_partition, uncompress_partition } from "./squeeze";

type PartitionData<T extends object> = { [key: string]: T };

// The Partition class definition, implementing the Partition type.
export class partition<T extends object> implements type_partition {
    partition_name: string;
    partition_indices: type_partition_index;
    storage_location: string;
    proto: any;
    json_output_file_path: string;
    txt_output_file_path: string;
    data: { [key: string]: any };
    primary_key: string;
    is_dirty: boolean = true; // Default is_dirty to true to indicate the partition requires saving upon creation.
    write_lock: boolean = false; // Default write_lock to false to indicate the partition is not currently being saved.
    do_compression: boolean;
    delete_key_list: string[];

    last_update_dt: Date;

    constructor({ storage_location, partition_indices, primary_key, proto, do_compression, partition_name, delete_key_list }: { storage_location: string, partition_indices: type_partition_index, primary_key: string, proto: new (data: T) => T, do_compression: boolean, partition_name?: string, delete_key_list?: string[] }) {
        this.partition_indices = partition_indices;
        this.primary_key = primary_key;
        this.proto = proto;
        this.data = {};
        this.partition_name = partition_name || partition_name_from_partition_index(partition_indices);
        this.delete_key_list = delete_key_list || [];

        this.storage_location = storage_location;
        this.json_output_file_path = `${storage_location}/${this.partition_name}.json`; // Storage location is derived from the table folder path and partition name.
        this.txt_output_file_path = `${storage_location}/${this.partition_name}.txt`; // Storage location is derived from the table folder path and partition name.

        this.last_update_dt = new Date();
        this.do_compression = do_compression || false;
    }

    update_last_update_dt = () => {
        if (this.is_dirty) {
            this.last_update_dt = new Date();
        }
    }

    /**
     * Inserts one or multiple new rows of data into the dataset.
     * The function normalizes single objects to arrays for unified processing.
     * It also flags the dataset as 'dirty' to indicate that changes have been made since the last save or update.
     * @param {any[] | any} data - The new data to be inserted, either a single object or an array of objects.
     */
    insert(data: T[] | T): void {
        // Normalize data into an array for unified processing
        const dataToInsert = Array.isArray(data) ? data : [data];

        // Insert each row into the dataset using its primary key for identification
        dataToInsert.forEach((row) => {
            const rowPk = get_from_dict(row, this.primary_key);
            if (rowPk === undefined) {
                throw new Error(`Primary key value missing in the data row. Cannot insert into partition. Table ${this.partition_name} and primary key ${this.primary_key} and value ${rowPk}`);
            }
            else if (this.data.hasOwnProperty(rowPk)) {
                throw new Error(`Duplicate primary key value: ${rowPk} for field ${this.primary_key} in partition ${this.partition_name}`);
            }
            this.data[rowPk] = row; // Insert the row into the dataset using the primary key as the index

            // Mark the dataset as 'dirty' to indicate that the state has changed   
            this.is_dirty = true;
        });

        this.update_last_update_dt()

    }

    update(row: T, fields_to_drop?: any[]): void {
        const rowPk = get_from_dict(row, this.primary_key);
        if (!this.data.hasOwnProperty(rowPk)) {
            throw new Error(`Row with primary key ${rowPk} does not exist in partition ${this.partition_name}.`);
        }

        // Drop fields if necessary
        if (fields_to_drop) {
            let copied_row = deep_copy(row);
            for (const field of fields_to_drop) {
                delete copied_row[field];
            }
            this.data[rowPk] = copied_row;
        }
        else {
            this.data[rowPk] = row;
        }

        // Update the row and mark partition as dirty
        this.is_dirty = true;
        this.update_last_update_dt()
    }


    /**
     * Asynchronously writes the current state of the object to a file in JSON format.
     * The write operation is performed only if changes have been made to the object (indicated by the 'is_dirty' flag).
     * The 'is_dirty' flag is reset to 'false' before writing to prevent redundant saves.
     */
    write_to_file = async (): Promise<void> => {
        // Skip writing to file if no changes have been made
        if (!this.is_dirty || this.write_lock) {
            return;
        }

        this.write_lock = true;
        const lockTimeout = setTimeout(() => this.write_lock = false, 10000);

        try {
            this.is_dirty = false;

            this.delete_keys_from_data();

            let data_to_write: string | Buffer = '';
            let output_file_path: string = '';

            if (this.do_compression) {
                data_to_write = await compress_partition(this);
                output_file_path = this.txt_output_file_path;
            }
            else {
                data_to_write = JSON.stringify({
                    partition_name: this.partition_name,
                    partition_indices: this.partition_indices,
                    data: this.data,
                    storage_location: this.storage_location,
                    primary_key: this.primary_key,
                    last_update_dt: this.last_update_dt,
                    delete_key_list: this.delete_key_list
                }, null, 2);
                output_file_path = this.json_output_file_path;
            }

            const dirname = path.dirname(output_file_path);
            await fs.mkdir(dirname, { recursive: true });

            const tempFilePath = output_file_path + '.tmp';
            await fs.writeFile(tempFilePath, data_to_write);

            await fs.rename(tempFilePath, output_file_path);
        } catch (error) {
            console.error("Error writing file:", error);
            this.is_dirty = true;
        } finally {
            clearTimeout(lockTimeout);
            this.write_lock = false;
        }
    }

    read_from_file = async () => {
        let output_file_path = this.do_compression ? this.txt_output_file_path : this.json_output_file_path;
        let proto = this.proto;

        try {

            let data_from_file = await fs.readFile(output_file_path);
            let data_to_parse;

            let parsed_data;

            if (this.do_compression) {
                parsed_data = await uncompress_partition(data_from_file);
            }
            else {
                data_to_parse = data_from_file.toString('utf-8');
                parsed_data = JSON.parse(data_to_parse);
            }

            this.partition_name = parsed_data.partition_name;
            this.partition_indices = parsed_data.partition_indices;
            this.data = parsed_data.data;
            this.storage_location = parsed_data.storage_location;
            this.primary_key = parsed_data.primary_key;
            this.last_update_dt = new Date(parsed_data.last_update_dt);
            this.delete_key_list = parsed_data.delete_key_list || [];

            return Promise.resolve();
        }
        catch (error) {
            console.log('Error reading from file', error, output_file_path)
        }
    }

    delete_keys_from_data = () => {
        let delete_key_list = this.delete_key_list || [];

        for (let key in this.data) {
            for (let delete_key of delete_key_list) {
                delete this.data[key][delete_key];
            }
        }
    }

    delete_file = async () => {
        let output_file_path = this.do_compression ? this.txt_output_file_path : this.json_output_file_path;

        try {
            this.data = {};

            // Delete the file associated with this partition
            await fs.unlink(output_file_path);
            // console.log(`Deleted file at: ${this.output_file_path}`);
        } catch (error) {
            // Handle possible errors, such as file not existing
            console.error(`Error deleting file at: ${output_file_path}`, error);
        }

        return Promise.resolve();
    }
}